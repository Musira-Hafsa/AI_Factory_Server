import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import authRoutes from './routes/auth.js';
import ticketRoutes from './routes/tickets.js';
import statsRoutes from './routes/stats.js';
import userRoutes from './routes/users.js';
import { notFound, errorHandler } from './middleware/error.js';
import { aiEnabled } from './services/aiService.js';

export function createApp() {
  const app = express();
  // CLIENT_ORIGIN may be a single URL or a comma-separated list (e.g. a
  // staging + production frontend), so accept both.
  const origin = (process.env.CLIENT_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  // Render (and most PaaS hosts) sit behind a reverse proxy — trust the
  // first hop so req.ip / req.secure reflect the real client, not the proxy.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors({ origin, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

  app.get('/api/health', (req, res) =>
    res.json({ ok: true, aiEnabled, time: new Date().toISOString() })
  );

  app.use('/api/auth', authRoutes);
  app.use('/api/tickets', ticketRoutes);
  app.use('/api/stats', statsRoutes);
  app.use('/api/users', userRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
