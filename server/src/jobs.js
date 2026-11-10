// Background runs: queue, progress, cancellation. Results are persisted via store.js.
//
// Works in two environments:
// - a long-lived Node process (local dev, a VM): runs continue after the HTTP response;
// - serverless (Vercel): waitUntil() keeps the function alive after the response,
//   up to the function's maxDuration. Progress and cancellation go through the
//   database, because the next poll may hit a different instance.
import { waitUntil } from '@vercel/functions';
import { createPromptEngine } from '@promptgen/engine';
import { getRun, updateRun } from './store.js';

const live = new Map();    // runId → { progress, controller }  (this instance only)
const queue = [];
let active = 0;
const FLUSH_MS = 1500;     // how often progress is written to the database

export const jobProgress = (id) => live.get(id)?.progress || null;

/**
 * Queue a generation run.
 * @param {string} runId
 * @param {object} input       engine generate() input
 * @param {{llm:object|null, concurrency:number, maxJobs:number}} opts
 */
export function enqueueRun(runId, input, { llm, concurrency, maxJobs }) {
  const controller = new AbortController();
  const progress = { round: 0, done: 0, total: 0, generated: 0, target: 0, log: [], updatedAt: Date.now() };
  live.set(runId, { progress, controller });
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  queue.push(() => execute(runId, input, { llm, concurrency, controller, progress }).finally(resolveDone));
  pump(maxJobs);
  waitUntil(done); // no-op outside Vercel
}

function pump(maxJobs) {
  while (active < maxJobs && queue.length) {
    const job = queue.shift();
    active++;
    job().finally(() => { active--; pump(maxJobs); });
  }
}

async function execute(runId, input, { llm, concurrency, controller, progress }) {
  if (controller.signal.aborted) return;
  await updateRun(runId, { status: 'running', progress });
  const engine = createPromptEngine({ llm: llm?.complete, concurrency });

  // Persist progress and pick up cancellation requested from another instance.
  let lastFlush = 0;
  let flushing = false;
  const flush = async (force = false) => {
    if (flushing || (!force && Date.now() - lastFlush < FLUSH_MS)) return;
    flushing = true;
    lastFlush = Date.now();
    try {
      progress.updatedAt = Date.now();
      const run = await updateRun(runId, { progress });
      if (run?.status === 'cancelling') controller.abort();
    } catch (err) {
      console.warn('[run] progress flush failed:', err.message);
    } finally {
      flushing = false;
    }
  };

  try {
    const r = await engine.generate(input, {
      signal: controller.signal,
      onProgress: (p) => {
        if (p.log) progress.log = [...progress.log, p.log].slice(-30);
        else Object.assign(progress, p);
        flush();
      },
    });
    await updateRun(runId, {
      status: 'done',
      prompts: r.prompts,
      keywords: r.keywords,
      profile: r.profile,
      target: r.target,
      stats: r.stats,
      usage: r.usage,
      warnings: r.warnings,
      log: r.log,
      progress: null,
    });
  } catch (err) {
    const cancelled = controller.signal.aborted;
    if (!cancelled) console.error('[run]', runId, err.message);
    await updateRun(runId, {
      status: cancelled ? 'cancelled' : 'failed',
      error: cancelled ? 'Cancelled' : err.issues ? err.issues.join('; ') : err.message,
      log: progress.log.map((msg) => ({ msg })),
      progress: null,
    });
  } finally {
    setTimeout(() => live.delete(runId), 60_000).unref?.();
  }
}

/** Cancel a run: directly if it runs on this instance, otherwise via the database flag. */
export async function cancelRun(runId) {
  const job = live.get(runId);
  if (job) {
    job.controller.abort();
    return true;
  }
  const run = await getRun(runId);
  if (run?.status === 'running') {
    await updateRun(runId, { status: 'cancelling' });
    return true;
  }
  return false;
}
