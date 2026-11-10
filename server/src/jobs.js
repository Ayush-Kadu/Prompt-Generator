// Background runs: queue, progress, cancellation. Results are persisted via store.js.
import { createPromptEngine } from '@promptgen/engine';
import { updateRun } from './store.js';

const live = new Map();    // runId → { progress, controller }
const queue = [];
let active = 0;

export const jobProgress = (id) => live.get(id)?.progress || null;

/**
 * Queue a generation run.
 * @param {string} runId
 * @param {object} input       engine generate() input
 * @param {{llm:object|null, concurrency:number, maxJobs:number}} opts
 */
export function enqueueRun(runId, input, { llm, concurrency, maxJobs }) {
  const controller = new AbortController();
  const progress = { round: 0, done: 0, total: 0, generated: 0, target: 0, log: [] };
  live.set(runId, { progress, controller });
  queue.push(() => execute(runId, input, { llm, concurrency, controller, progress }));
  pump(maxJobs);
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
  await updateRun(runId, { status: 'running' });
  const engine = createPromptEngine({ llm: llm?.complete, concurrency });
  try {
    const r = await engine.generate(input, {
      signal: controller.signal,
      onProgress: (p) => {
        if (p.log) progress.log = [...progress.log, p.log].slice(-30);
        else Object.assign(progress, p);
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
    });
  } catch (err) {
    const cancelled = controller.signal.aborted;
    if (!cancelled) console.error('[run]', runId, err.message);
    await updateRun(runId, {
      status: cancelled ? 'cancelled' : 'failed',
      error: cancelled ? 'Cancelled' : err.issues ? err.issues.join('; ') : err.message,
      log: progress.log.map((msg) => ({ msg })),
    });
  } finally {
    setTimeout(() => live.delete(runId), 60_000).unref();
  }
}

export function cancelRun(runId) {
  const job = live.get(runId);
  if (!job) return false;
  job.controller.abort();
  return true;
}
