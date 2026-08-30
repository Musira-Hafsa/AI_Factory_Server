import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { listUsers, updateUserRole } from '../controllers/userController.js';

const router = Router();

// User administration is admin-only, end to end.
router.use(requireAuth, requireRole('admin'));

router.get('/', listUsers);
router.patch('/:id/role', updateUserRole);

export default router;
