import 'dotenv/config';
import http from 'http';
import { createApp } from './app.js';
import { connectDB } from './config/db.js';
import { initSocket } from './socket/io.js';
import { aiEnabled } from './services/aiService.js';

import dns from 'node:dns';

// Force Node.js to use Google DNS for resolving Atlas SRV records
dns.setServers(['8.8.8.8', '1.1.1.1']);
const PORT = process.env.PORT || 4000;
const ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

async function main() {
  if (!process.env.JWT_SECRET) {
    console.error('[fatal] JWT_SECRET is not set. Copy .env.example to .env.');
    process.exit(1);
  }

  await connectDB(process.env.MONGODB_URI);

  const app = createApp();
  const server = http.createServer(app);
  initSocket(server, ORIGIN);

  server.listen(PORT, () => {
    console.log(`[api] listening on http://localhost:${PORT}`);
    console.log(`[ai]  triage provider: ${aiEnabled ? 'Claude' : 'mock fallback (no ANTHROPIC_API_KEY)'}`);
  });
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
