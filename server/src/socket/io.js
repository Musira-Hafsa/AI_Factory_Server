import { Server } from 'socket.io';
import { authenticateSocket } from '../middleware/auth.js';

let io = null;

export function initSocket(httpServer, origin) {
  io = new Server(httpServer, {
    cors: { origin, methods: ['GET', 'POST'], credentials: true },
  });

  io.use(authenticateSocket);

  io.on('connection', (socket) => {
    const user = socket.data.user;
    // Personal room + a shared room for every agent/admin (dashboard updates).
    socket.join(`user:${user.id}`);
    if (user.role === 'agent' || user.role === 'admin') socket.join('role:agent');

    // Join/leave a specific ticket conversation.
    socket.on('ticket:join', (ticketId) => socket.join(`ticket:${ticketId}`));
    socket.on('ticket:leave', (ticketId) => socket.leave(`ticket:${ticketId}`));

    // Real-time typing indicator, relayed to the other participants.
    socket.on('typing', ({ ticketId, isTyping }) => {
      socket.to(`ticket:${ticketId}`).emit('typing', {
        ticketId,
        user: { id: user.id, name: user.name, role: user.role },
        isTyping: Boolean(isTyping),
      });
    });
  });

  return io;
}

export function emitToTicket(ticketId, event, payload) {
  io?.to(`ticket:${ticketId}`).emit(event, payload);
}

export function emitToAgents(event, payload) {
  io?.to('role:agent').emit(event, payload);
}

export function emitToUser(userId, event, payload) {
  io?.to(`user:${userId}`).emit(event, payload);
}
