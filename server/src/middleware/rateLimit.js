// Minimal in-memory fixed-window rate limiter — no extra dependency required.
// Good enough for a single-instance deploy; swap for a shared store (Redis)
// if this ever runs behind multiple instances.
export function rateLimit({ windowMs = 60_000, max = 20 } = {}) {
  const hits = new Map(); // key -> { count, resetAt }

  return function rateLimiter(req, res, next) {
    const key = req.ip;
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      return res.status(429).json({ error: 'Too many requests, please try again later' });
    }
    next();
  };
}
