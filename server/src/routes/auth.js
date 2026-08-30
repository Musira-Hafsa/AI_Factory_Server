import { Router } from 'express';
import { register, login, me, listAgents } from '../controllers/authController.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

router.post('/register', register);
router.post('/login', login);
router.get('/me', requireAuth, me);
router.get('/agents', requireAuth, requireRole('agent', 'admin'), listAgents);

export default router;
