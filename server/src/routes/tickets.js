import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  createTicket,
  listTickets,
  getTicket,
  runTriage,
  finalizeTriage,
  assignTicket,
  addMessage,
  updateStatus,
  reopenTicket,
  resolutionSummary,
} from '../controllers/ticketController.js';

const router = Router();

// Every ticket route is protected.
router.use(requireAuth);

router.route('/')
  .get(listTickets)
  .post(requireRole('customer'), createTicket);

router.get('/:id', getTicket);
router.post('/:id/messages', addMessage);
router.post('/:id/reopen', reopenTicket);

// Staff-only.
router.post('/:id/triage', requireRole('agent', 'admin'), runTriage);
router.patch('/:id/triage/finalize', requireRole('agent', 'admin'), finalizeTriage);
router.patch('/:id/assign', requireRole('agent', 'admin'), assignTicket);
router.patch('/:id/status', requireRole('agent', 'admin'), updateStatus);
router.post('/:id/resolution-summary', requireRole('agent', 'admin'), resolutionSummary);

export default router;
