import mongoose from 'mongoose';
import { Counter } from './Counter.js';
import { CATEGORIES, PRIORITIES, STATUSES } from '../config/constants.js';

const messageSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    authorRole: { type: String, required: true },
    authorName: { type: String, required: true },
    body: { type: String, required: true, trim: true },
    // Marks the reply that resolved the ticket (resolution note).
    isResolutionNote: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Audit trail entry — every status/priority/assignment change.
const eventSchema = new mongoose.Schema(
  {
    type: { type: String, required: true }, // created | status | priority | assigned | triage | reopened
    message: { type: String, required: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: String,
  },
  { timestamps: true }
);

const aiSuggestionSchema = new mongoose.Schema(
  {
    category: { type: String, enum: CATEGORIES },
    priority: { type: String, enum: PRIORITIES },
    summary: { type: String },
    source: { type: String }, // claude | mock | fallback
    model: String,
    error: String, // populated when the AI call failed and we used the fallback
    generatedAt: Date,
    finalized: { type: Boolean, default: false },
    finalizedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    finalizedAt: Date,
  },
  { _id: false }
);

const ticketSchema = new mongoose.Schema(
  {
    ticketNumber: { type: String, unique: true, index: true },
    subject: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },

    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    assignedAgent: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    // Customer's optional guess; the agent-finalized value is `category`.
    requestedCategory: { type: String, enum: CATEGORIES },
    category: { type: String, enum: CATEGORIES },
    priority: { type: String, enum: PRIORITIES, default: 'Medium' },
    status: { type: String, enum: STATUSES, default: 'New', index: true },

    aiSuggestion: { type: aiSuggestionSchema, default: null },
    resolutionSummary: { type: String, default: '' }, // bonus: AI-generated
    resolvedAt: Date,
    reopenCount: { type: Number, default: 0 },

    messages: [messageSchema],
    events: [eventSchema],
  },
  { timestamps: true }
);

ticketSchema.pre('validate', async function assignNumber(next) {
  if (this.isNew && !this.ticketNumber) {
    const seq = await Counter.next('ticket');
    this.ticketNumber = `TKT-${String(seq).padStart(6, '0')}`;
  }
  next();
});

export const Ticket = mongoose.model('Ticket', ticketSchema);
