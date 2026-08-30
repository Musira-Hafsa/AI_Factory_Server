import mongoose from 'mongoose';
import { Ticket } from '../models/Ticket.js';
import { User } from '../models/User.js';
import { asyncHandler, HttpError } from '../middleware/error.js';
import {
  CATEGORIES,
  PRIORITIES,
  STATUSES,
  STATUS_TRANSITIONS,
} from '../config/constants.js';
import { triageTicket, generateResolutionSummary, validateTriage, aiEnabled } from '../services/aiService.js';
import { pickAgentForCategory } from '../services/assignmentService.js';
import { emitToTicket, emitToAgents, emitToUser } from '../socket/io.js';

const POPULATE = [
  { path: 'customer', select: 'name email role' },
  { path: 'assignedAgent', select: 'name email role' },
];

function serialize(t) {
  return {
    id: t._id,
    ticketNumber: t.ticketNumber,
    subject: t.subject,
    description: t.description,
    status: t.status,
    priority: t.priority,
    category: t.category,
    requestedCategory: t.requestedCategory,
    customer: t.customer && { id: t.customer._id, name: t.customer.name, email: t.customer.email },
    assignedAgent: t.assignedAgent && {
      id: t.assignedAgent._id,
      name: t.assignedAgent.name,
      email: t.assignedAgent.email,
    },
    aiSuggestion: t.aiSuggestion || null,
    resolutionSummary: t.resolutionSummary || '',
    reopenCount: t.reopenCount,
    resolvedAt: t.resolvedAt,
    messages: (t.messages || []).map((m) => ({
      id: m._id,
      author: m.author,
      authorRole: m.authorRole,
      authorName: m.authorName,
      body: m.body,
      isResolutionNote: m.isResolutionNote,
      createdAt: m.createdAt,
    })),
    events: (t.events || []).map((e) => ({
      id: e._id,
      type: e.type,
      message: e.message,
      byName: e.byName,
      createdAt: e.createdAt,
    })),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

function assertValidId(id) {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(400, 'Invalid ticket id');
}

async function loadTicket(id) {
  assertValidId(id);
  const ticket = await Ticket.findById(id).populate(POPULATE);
  if (!ticket) throw new HttpError(404, 'Ticket not found');
  return ticket;
}

function canView(user, ticket) {
  if (user.role === 'admin') return true;
  if (user.role === 'agent') return true; // agents see the full queue
  return String(ticket.customer._id || ticket.customer) === String(user._id);
}

// Who may change workflow fields (status, messages as staff, triage).
function canManage(user, ticket) {
  if (user.role === 'admin') return true;
  if (user.role === 'agent') {
    return (
      !ticket.assignedAgent ||
      String(ticket.assignedAgent._id || ticket.assignedAgent) === String(user._id)
    );
  }
  return false;
}

function pushEvent(ticket, type, message, user) {
  ticket.events.push({ type, message, by: user._id, byName: user.name });
}

// Emit the fresh ticket to everyone who cares.
function broadcast(ticket, event = 'ticket:updated') {
  const payload = serialize(ticket);
  emitToTicket(ticket._id, event, payload);
  emitToAgents('ticket:updated', payload);
  emitToUser(ticket.customer._id || ticket.customer, 'ticket:updated', payload);
}

// ---------------------------------------------------------------------------
// Create (customer)
// ---------------------------------------------------------------------------
export const createTicket = asyncHandler(async (req, res) => {
  const { subject, description, category } = req.body;
  if (!subject?.trim() || !description?.trim()) {
    throw new HttpError(400, 'Subject and description are required');
  }
  if (category && !CATEGORIES.includes(category)) {
    throw new HttpError(400, 'Unknown category');
  }

  const ticket = new Ticket({
    subject: subject.trim(),
    description: description.trim(),
    requestedCategory: category || undefined,
    customer: req.user._id,
    status: 'New',
  });
  ticket.events.push({
    type: 'created',
    message: `Ticket created by ${req.user.name}`,
    by: req.user._id,
    byName: req.user.name,
  });
  await ticket.save();
  await ticket.populate(POPULATE);

  emitToAgents('ticket:new', serialize(ticket));
  res.status(201).json({ ticket: serialize(ticket) });
});

// ---------------------------------------------------------------------------
// List (role-aware)
// ---------------------------------------------------------------------------
export const listTickets = asyncHandler(async (req, res) => {
  const { status, priority, scope } = req.query;
  const filter = {};

  if (req.user.role === 'customer') {
    filter.customer = req.user._id;
  } else if (req.user.role === 'agent' && scope === 'mine') {
    filter.assignedAgent = req.user._id;
  } else if (req.user.role === 'agent' && scope === 'unassigned') {
    filter.assignedAgent = null;
  }

  if (status && STATUSES.includes(status)) filter.status = status;
  if (priority && PRIORITIES.includes(priority)) filter.priority = priority;

  const tickets = await Ticket.find(filter)
    .populate(POPULATE)
    .sort({ updatedAt: -1 })
    .limit(200);

  res.json({ tickets: tickets.map(serialize) });
});

// ---------------------------------------------------------------------------
// Get one
// ---------------------------------------------------------------------------
export const getTicket = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  if (!canView(req.user, ticket)) throw new HttpError(403, 'You cannot view this ticket');
  res.json({ ticket: serialize(ticket) });
});

// ---------------------------------------------------------------------------
// AI triage — generates a SUGGESTION only. Nothing is applied here.
// ---------------------------------------------------------------------------
export const runTriage = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  if (!canManage(req.user, ticket)) throw new HttpError(403, 'Not allowed to triage this ticket');

  const result = await triageTicket({
    subject: ticket.subject,
    description: ticket.description,
    requestedCategory: ticket.requestedCategory,
  });

  ticket.aiSuggestion = { ...result, finalized: false };
  pushEvent(
    ticket,
    'triage',
    `AI triage (${result.source}): ${result.category} / ${result.priority}`,
    req.user
  );
  await ticket.save();
  await ticket.populate(POPULATE);

  broadcast(ticket);
  res.json({ ticket: serialize(ticket), suggestion: ticket.aiSuggestion });
});

// ---------------------------------------------------------------------------
// Finalize triage — agent-reviewed/edited values are applied to the ticket.
// ---------------------------------------------------------------------------
export const finalizeTriage = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  if (!canManage(req.user, ticket)) throw new HttpError(403, 'Not allowed to triage this ticket');
  if (ticket.status === 'Resolved') throw new HttpError(409, 'Reopen the ticket before re-triaging');

  const { category, priority, summary } = req.body;

  // Validate the (possibly edited) values before storing — same gate the AI output goes through.
  let clean;
  try {
    clean = validateTriage({ category, priority, summary });
  } catch (err) {
    throw new HttpError(400, err.message);
  }

  ticket.category = clean.category;
  ticket.priority = clean.priority;
  ticket.aiSuggestion = {
    ...(ticket.aiSuggestion?.toObject?.() || ticket.aiSuggestion || {}),
    category: clean.category,
    priority: clean.priority,
    summary: clean.summary,
    finalized: true,
    finalizedBy: req.user._id,
    finalizedAt: new Date(),
  };

  pushEvent(ticket, 'triage', `Triage finalized: ${clean.category} / ${clean.priority}`, req.user);

  // Auto-assign on first finalize if still unassigned.
  let assignmentNote = null;
  if (!ticket.assignedAgent) {
    const agent = await pickAgentForCategory(clean.category);
    if (agent) {
      ticket.assignedAgent = agent._id;
      if (ticket.status === 'New') ticket.status = 'Assigned';
      assignmentNote = `Auto-assigned to ${agent.name} (${clean.category})`;
      pushEvent(ticket, 'assigned', assignmentNote, req.user);
    }
  }

  await ticket.save();
  await ticket.populate(POPULATE);

  broadcast(ticket);
  if (ticket.assignedAgent) {
    emitToUser(ticket.assignedAgent._id, 'ticket:assigned', serialize(ticket));
  }
  res.json({ ticket: serialize(ticket), assignmentNote });
});

// ---------------------------------------------------------------------------
// Assign / self-assign
// ---------------------------------------------------------------------------
export const assignTicket = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  if (ticket.status === 'Resolved') throw new HttpError(409, 'Reopen the ticket before reassigning');

  let agentId = req.body.agentId;
  if (req.user.role === 'agent') {
    // Agents may only claim a ticket for themselves.
    if (agentId && String(agentId) !== String(req.user._id)) {
      throw new HttpError(403, 'Agents can only assign tickets to themselves');
    }
    agentId = req.user._id;
  }
  if (req.user.role === 'admin' && !agentId) throw new HttpError(400, 'agentId is required');

  const agent = await User.findById(agentId);
  if (!agent || agent.role !== 'agent') throw new HttpError(400, 'That user is not an agent');

  ticket.assignedAgent = agent._id;
  if (ticket.status === 'New') ticket.status = 'Assigned';
  pushEvent(ticket, 'assigned', `Assigned to ${agent.name}`, req.user);

  await ticket.save();
  await ticket.populate(POPULATE);

  broadcast(ticket);
  emitToUser(agent._id, 'ticket:assigned', serialize(ticket));
  res.json({ ticket: serialize(ticket) });
});

// ---------------------------------------------------------------------------
// Add a conversation message
// ---------------------------------------------------------------------------
export const addMessage = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  const { body } = req.body;
  if (!body?.trim()) throw new HttpError(400, 'Message body is required');

  const isCustomer = String(ticket.customer._id) === String(req.user._id);
  const isStaff = canManage(req.user, ticket);
  if (!isCustomer && !isStaff) throw new HttpError(403, 'You cannot post to this ticket');

  if (ticket.status === 'Resolved') {
    throw new HttpError(409, 'This ticket is resolved. Reopen it to continue the conversation.');
  }

  const message = {
    author: req.user._id,
    authorRole: req.user.role,
    authorName: req.user.name,
    body: body.trim(),
  };
  ticket.messages.push(message);

  // First agent reply moves the ticket into "In Progress".
  if (isStaff && ticket.status === 'Assigned') {
    ticket.status = 'In Progress';
    pushEvent(ticket, 'status', 'Status → In Progress (agent replied)', req.user);
  }

  await ticket.save();
  await ticket.populate(POPULATE);

  const saved = serialize(ticket);
  const newMessage = saved.messages[saved.messages.length - 1];
  emitToTicket(ticket._id, 'message:new', { ticketId: String(ticket._id), message: newMessage });
  emitToAgents('ticket:updated', saved);
  emitToUser(ticket.customer._id, 'ticket:updated', saved);
  if (ticket.assignedAgent) emitToUser(ticket.assignedAgent._id, 'ticket:updated', saved);

  res.status(201).json({ ticket: saved, message: newMessage });
});

// ---------------------------------------------------------------------------
// Update status (workflow-enforced)
// ---------------------------------------------------------------------------
export const updateStatus = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  if (!canManage(req.user, ticket)) throw new HttpError(403, 'Not allowed to update this ticket');

  const { status, resolutionNote, resolutionSummary } = req.body;
  if (!STATUSES.includes(status)) throw new HttpError(400, 'Unknown status');

  if (ticket.status === 'Resolved') {
    throw new HttpError(409, 'A resolved ticket cannot change status. Reopen it first.');
  }
  if (status === ticket.status) throw new HttpError(400, `Ticket is already ${status}`);

  const allowed = STATUS_TRANSITIONS[ticket.status] || [];
  if (!allowed.includes(status)) {
    throw new HttpError(400, `Cannot move from ${ticket.status} to ${status}`);
  }

  if (status === 'Resolved') {
    if (!resolutionNote?.trim()) {
      throw new HttpError(400, 'A resolution note is required to resolve a ticket');
    }
    ticket.messages.push({
      author: req.user._id,
      authorRole: req.user.role,
      authorName: req.user.name,
      body: resolutionNote.trim(),
      isResolutionNote: true,
    });
    if (resolutionSummary?.trim()) ticket.resolutionSummary = resolutionSummary.trim();
    ticket.resolvedAt = new Date();
  }

  if (status === 'Assigned' && !ticket.assignedAgent) {
    throw new HttpError(400, 'Assign an agent before setting the ticket to Assigned');
  }

  ticket.status = status;
  pushEvent(ticket, 'status', `Status → ${status}`, req.user);

  await ticket.save();
  await ticket.populate(POPULATE);

  broadcast(ticket);
  res.json({ ticket: serialize(ticket) });
});

// ---------------------------------------------------------------------------
// Reopen a resolved ticket
// ---------------------------------------------------------------------------
export const reopenTicket = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);

  const isCustomer = String(ticket.customer._id) === String(req.user._id);
  if (!isCustomer && !canManage(req.user, ticket)) {
    throw new HttpError(403, 'You cannot reopen this ticket');
  }
  if (ticket.status !== 'Resolved') throw new HttpError(409, 'Only resolved tickets can be reopened');

  const { reason } = req.body;
  ticket.status = ticket.assignedAgent ? 'In Progress' : 'New';
  ticket.resolvedAt = null;
  ticket.reopenCount += 1;
  if (reason?.trim()) {
    ticket.messages.push({
      author: req.user._id,
      authorRole: req.user.role,
      authorName: req.user.name,
      body: `Reopened: ${reason.trim()}`,
    });
  }
  pushEvent(ticket, 'reopened', `Ticket reopened by ${req.user.name}`, req.user);

  await ticket.save();
  await ticket.populate(POPULATE);

  broadcast(ticket);
  emitToAgents('ticket:updated', serialize(ticket));
  res.json({ ticket: serialize(ticket) });
});

// ---------------------------------------------------------------------------
// Bonus: AI resolution summary (suggestion for the agent to use)
// ---------------------------------------------------------------------------
export const resolutionSummary = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  if (!canManage(req.user, ticket)) throw new HttpError(403, 'Not allowed');

  const result = await generateResolutionSummary({
    subject: ticket.subject,
    description: ticket.description,
    messages: ticket.messages,
  });
  res.json({ ...result, aiEnabled });
});
