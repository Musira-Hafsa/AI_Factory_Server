import 'dotenv/config';
import http from 'http';
import { createApp } from './app.js';
import { connectDB } from './config/db.js';
import { initSocket } from './socket/io.js';
import { aiEnabled } from './services/aiService.js';

import dns from 'node:dns';

// Force Node.js to use Google DNS for resolving Atlas SRV records. This
// works around a local/Windows DNS quirk; production hosts (Render, etc.)
// resolve SRV records fine on their own and shouldn't have their DNS
// overridden.
if (process.env.NODE_ENV !== 'production') {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
}

const PORT = process.env.PORT || 4000;
// Same origin(s) the Express app trusts for CORS — kept in sync so the
// Socket.IO handshake isn't rejected by a stricter/looser origin list.
const ORIGIN = (process.env.CLIENT_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

async function main() {
  if (!process.env.JWT_SECRET) {
    console.error('[fatal] JWT_SECRET is not set. Copy .env.example to .env.');
    process.exit(1);
  }

  const db = await connectDB(process.env.MONGODB_URI);

  const app = createApp();
  const server = http.createServer(app);
  initSocket(server, ORIGIN);

  server.listen(PORT, () => {
    console.log(`[api] listening on http://localhost:${PORT}`);
    console.log(`[ai]  triage provider: ${aiEnabled ? 'Claude' : 'mock fallback (no ANTHROPIC_API_KEY)'}`);
  });

  // Render (and most PaaS hosts) send SIGTERM before stopping/redeploying a
  // service — stop accepting new connections and close the DB cleanly
  // instead of dropping in-flight requests.
  const shutdown = (signal) => {
    console.log(`[api] ${signal} received, shutting down`);
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
