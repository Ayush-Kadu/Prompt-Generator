import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProviderRegistry } from '@promptgen/providers';
import { createV1Router } from './api/v1.js';
import { apiKeyAuth, errorHandler, rateLimit } from './middleware.js';

export function loadConfig(env = process.env) {
  const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    apiKeys: list(env.ENGINE_API_KEYS),
    corsOrigins: list(env.CORS_ORIGINS),
    rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 120),
    concurrency: Number(env.AGENT_CONCURRENCY) || 3,
    maxJobs: Number(env.MAX_CONCURRENT_RUNS) || 2,
    maxSyncPrompts: Number(env.MAX_SYNC_PROMPTS) || 500,
    serverless: Boolean(env.VERCEL),
    // Runs with no progress for this long are marked failed. Keep it above the
    // function's maxDuration on serverless (300 s in vercel.json).
    staleRunMs: Number(env.STALE_RUN_MS) || 6 * 60_000,
  };
}

/** Build the Express app. Exported separately from index.js so tests can mount it. */
export function createApp({ env = process.env, registry = createProviderRegistry({ env }), config = loadConfig(env) } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors(config.corsOrigins.length ? { origin: config.corsOrigins } : {}));
  app.use(express.json({ limit: '5mb' }));

  const v1 = createV1Router({ registry, config });
  app.use('/api/v1', apiKeyAuth(config.apiKeys), rateLimit({ perMinute: config.rateLimitPerMinute }), v1);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found. The API lives under /api/v1.' }));

  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use(errorHandler);
  return { app, registry, config };
}
