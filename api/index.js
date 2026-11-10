// Vercel serverless entry for the Express API. vercel.json rewrites every
// /api/* request here; req.url keeps the original path, so Express routes
// (/api/v1/...) match unchanged. Local dev keeps using server/src/index.js.
import { createApp } from '../server/src/app.js';
import { connectStore } from '../server/src/store.js';

// Runs once per function instance and is reused by later invocations.
const ready = connectStore();
const { app } = createApp();

export default async function handler(req, res) {
  await ready;
  return app(req, res);
}
