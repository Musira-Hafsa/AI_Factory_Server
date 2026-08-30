import { User } from '../models/User.js';
import { asyncHandler, HttpError } from '../middleware/error.js';
import { signToken } from '../middleware/auth.js';
import bcrypt from 'bcryptjs';  

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const register = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    throw new HttpError(400, 'Name, email, and password are required');
  }
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address');
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');

  const exists = await User.findOne({ email: email.toLowerCase() });
  if (exists) throw new HttpError(409, 'An account with that email already exists');

  // Public self-registration is customer-only. Agents/admins are seeded or
  // promoted by an admin — a signup form can't grant itself staff access.
  const user = new User({ name, email, role: 'customer' });
  await user.setPassword(password);
  await user.save();

  res.status(201).json({ token: signToken(user), user: user.toSafeJSON() });
});

export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) throw new HttpError(400, 'Email and password are required');

  const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');
  if (!user || !(await user.verifyPassword(password))) {
    throw new HttpError(401, 'Incorrect email or password');
  }

  res.json({ token: signToken(user), user: user.toSafeJSON() });
});

export const me = asyncHandler(async (req, res) => {
  res.json({ user: req.user.toSafeJSON() });
});

// Used by the agent UI to show assignee options.
export const listAgents = asyncHandler(async (req, res) => {
  const agents = await User.find({ role: 'agent' }).sort('name');
  res.json({ agents: agents.map((a) => a.toSafeJSON()) });
});
