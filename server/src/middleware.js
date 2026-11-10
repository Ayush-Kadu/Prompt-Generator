// API-key auth, rate limiting and error mapping for the HTTP API.
import { timingSafeEqual } from 'node:crypto';

/**
 * When ENGINE_API_KEYS is set (comma separated), every /api/v1 request must send
 * `Authorization: Bearer <key>` or `x-api-key: <key>`. Unset = open (local use).
 */
export function apiKeyAuth(keys) {
  const allowed = keys.map((k) => Buffer.from(k));
  return (req, res, next) => {
    if (!allowed.length || req.path === '/health') return next();
    const header = req.get('authorization') || '';
    const raw = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : (req.get('x-api-key') || '').trim();
    const given = Buffer.from(raw);
    const ok = raw && allowed.some((k) => k.length === given.length && timingSafeEqual(k, given));
    if (!ok) return res.status(401).json({ error: 'Missing or invalid API key' });
    req.apiKeyId = raw.slice(0, 6);
    next();
  };
}

/** Fixed-window limiter per API key (or IP). Good enough for one instance. */
export function rateLimit({ perMinute }) {
  const hits = new Map();
  setInterval(() => hits.clear(), 60_000).unref();
  return (req, res, next) => {
    if (!perMinute) return next();
    const who = req.apiKeyId || req.ip;
    const n = (hits.get(who) || 0) + 1;
    hits.set(who, n);
    res.setHeader('X-RateLimit-Limit', perMinute);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, perMinute - n));
    if (n > perMinute) return res.status(429).json({ error: 'Rate limit exceeded, try again in a minute' });
    next();
  };
}

export const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  if (err.name === 'EngineValidationError') return res.status(400).json({ error: 'Invalid input', details: err.issues });
  if (err.name === 'ProviderError') {
    return res.status(502).json({ error: err.message, provider: err.provider, providerStatus: err.status ?? null });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Body is not valid JSON' });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
}
