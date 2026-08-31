import { Router } from 'express';
import { register, login, me, listAgents } from '../controllers/authController.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

// Brute-force / signup-spam guard — only on the unauthenticated endpoints.
const authLimiter = rateLimit({ windowMs: 60_000, max: 20 });

router.post('/register', authLimiter, register);
router.post('/login', authLimiter, login);
router.get('/me', requireAuth, me);
router.get('/agents', requireAuth, requireRole('agent', 'admin'), listAgents);

export default router;
