import { Ticket } from '../models/Ticket.js';
import { asyncHandler } from '../middleware/error.js';
import { STATUSES, PRIORITIES, CATEGORIES } from '../config/constants.js';

// Dashboard statistics computed from real ticket data.
// Customers get their own numbers; agents/admins get the whole desk.
export const getStats = asyncHandler(async (req, res) => {
  const match = {};
  if (req.user.role === 'customer') match.customer = req.user._id;
  if (req.user.role === 'agent') match.assignedAgent = req.user._id;

  const [total, byStatusRaw, byPriorityRaw, byCategoryRaw, resolvedDocs] = await Promise.all([
    Ticket.countDocuments(match),
    Ticket.aggregate([{ $match: match }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Ticket.aggregate([{ $match: match }, { $group: { _id: '$priority', n: { $sum: 1 } } }]),
    Ticket.aggregate([{ $match: match }, { $group: { _id: '$category', n: { $sum: 1 } } }]),
    Ticket.find({ ...match, status: 'Resolved', resolvedAt: { $ne: null } }).select('createdAt resolvedAt'),
  ]);

  const fill = (rows, keys) => {
    const out = Object.fromEntries(keys.map((k) => [k, 0]));
    for (const r of rows) if (r._id != null && r._id in out) out[r._id] = r.n;
    return out;
  };

  const byStatus = fill(byStatusRaw, STATUSES);
  const open = total - (byStatus.Resolved || 0);

  const resolutionTimesMs = resolvedDocs.map((t) => t.resolvedAt - t.createdAt).filter((n) => n > 0);
  const avgResolutionHours = resolutionTimesMs.length
    ? Number(
        (resolutionTimesMs.reduce((a, b) => a + b, 0) / resolutionTimesMs.length / 3_600_000).toFixed(1)
      )
    : null;

  res.json({
    scope: req.user.role,
    total,
    open,
    resolved: byStatus.Resolved || 0,
    byStatus,
    byPriority: fill(byPriorityRaw, PRIORITIES),
    byCategory: fill(byCategoryRaw, CATEGORIES),
    avgResolutionHours,
    awaitingTriage: await Ticket.countDocuments({ ...match, 'aiSuggestion.finalized': { $ne: true } }),
  });
});
