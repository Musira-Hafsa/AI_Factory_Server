import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { asyncHandler, HttpError } from '../middleware/error.js';
import { ROLES } from '../config/constants.js';
import { emitToAgents } from '../socket/io.js';

// Admin-facing view of a user row. Includes createdAt ("Date Joined") which
// toSafeJSON() deliberately omits for the normal auth payload.
function serialize(u) {
  return {
    id: u._id,
    name: u.name,
    email: u.email,
    role: u.role,
    categories: u.categories || [],
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// GET /api/users — every registered user (admin only)
// ---------------------------------------------------------------------------
export const listUsers = asyncHandler(async (req, res) => {
  const users = await User.find().sort({ createdAt: 1 });
  res.json({ users: users.map(serialize) });
});

// ---------------------------------------------------------------------------
// PATCH /api/users/:id/role — promote/demote a user (admin only)
// ---------------------------------------------------------------------------
export const updateUserRole = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;

  if (!mongoose.isValidObjectId(id)) throw new HttpError(400, 'Invalid user id');
  if (!ROLES.includes(role)) {
    throw new HttpError(400, `Role must be one of: ${ROLES.join(', ')}`);
  }

  const user = await User.findById(id);
  if (!user) throw new HttpError(404, 'User not found');

  // Guard against an admin locking themselves (or the last admin) out.
  if (String(user._id) === String(req.user._id) && role !== 'admin') {
    throw new HttpError(400, 'You cannot change your own admin role');
  }
  if (user.role === 'admin' && role !== 'admin') {
    const adminCount = await User.countDocuments({ role: 'admin' });
    if (adminCount <= 1) throw new HttpError(400, 'At least one admin must remain');
  }

  if (user.role === role) throw new HttpError(400, `User is already ${role}`);

  user.role = role;
  // Category routing only applies to agents — clear it otherwise.
  if (role !== 'agent') user.categories = [];
  await user.save();

  const payload = serialize(user);
  emitToAgents('user:updated', payload);
  res.json({ user: payload });
});
