import { User } from '../models/User.js';
import { Ticket } from '../models/Ticket.js';

// Bonus: automatic assignment by category.
// Picks the agent who lists this category and currently has the fewest open
// tickets. Falls back to the least-loaded agent overall.
export async function pickAgentForCategory(category) {
  const byCategory = category
    ? await User.find({ role: 'agent', categories: category })
    : [];
  const pool = byCategory.length
    ? byCategory
    : await User.find({ role: 'agent' });

  if (!pool.length) return null;

  const loads = await Promise.all(
    pool.map(async (agent) => ({
      agent,
      open: await Ticket.countDocuments({
        assignedAgent: agent._id,
        status: { $ne: 'Resolved' },
      }),
    }))
  );

  loads.sort((a, b) => a.open - b.open);
  return loads[0].agent;
}
