// Versioned public API. A thin HTTP layer: it picks a provider, builds an
// engine, and maps results. All prompt logic lives in @promptgen/engine.
import express, { Router } from 'express';
import { z } from 'zod';
import {
  BRAND_MODES, ENGINE_VERSION, INTENTS, LANGUAGES, LIMITS, SCORE_WEIGHTS, SENTIMENTS, createPromptEngine, expectedPrompts, normalizeGenerateRequest,
} from '@promptgen/engine';
import { asyncRoute } from '../middleware.js';
import { cancelRun, enqueueRun, jobProgress } from '../jobs.js';
import { createRun, deleteRun, getRun, listRuns, storeKind, updateRun } from '../store.js';
import { buildWorkbook, fileName, toCsv } from '../exporters.js';
import { readKeywordsFromXlsx } from '../importers.js';

/**
 * @param {{registry: ReturnType<import('@promptgen/providers').createProviderRegistry>, config: object}} deps
 */
export function createV1Router({ registry, config }) {
  const router = Router();

  /** Resolve { provider, model } from the body (or defaults) into an llm adapter (null = offline). */
  const llmFor = (body = {}) => {
    const llm = registry.get(typeof body.provider === 'string' ? body.provider : undefined, {
      model: typeof body.model === 'string' && body.model.trim() ? body.model : undefined,
    });
    return { llm, provider: llm?.id || 'offline', model: llm?.model || 'templates' };
  };
  const engineFor = (body) => {
    const { llm, provider, model } = llmFor(body);
    return { engine: createPromptEngine({ llm: llm?.complete, concurrency: config.concurrency }), llm, provider, model };
  };

  router.get('/health', (_req, res) => res.json({ ok: true, engine: ENGINE_VERSION }));

  router.get('/meta', (_req, res) => {
    res.json({
      engineVersion: ENGINE_VERSION,
      intents: INTENTS,
      sentiments: SENTIMENTS,
      brandModes: BRAND_MODES,
      languages: LANGUAGES,
      limits: { ...LIMITS, maxSyncPrompts: config.maxSyncPrompts },
      scoreWeights: SCORE_WEIGHTS,
      providers: registry.list(),
      defaultProvider: registry.defaultId(),
      store: storeKind(),
      serverless: config.serverless,
    });
  });

  router.get('/providers', (_req, res) => res.json({ default: registry.defaultId(), providers: registry.list() }));

  // ── Engine modules, callable on their own ────────────────────────────────
  router.post('/brand/analyze', asyncRoute(async (req, res) => {
    const { engine, provider, model } = engineFor(req.body);
    res.json({ ...(await engine.analyzeBrand(req.body)), provider, model });
  }));

  router.post('/keywords/extract', asyncRoute(async (req, res) => {
    const { engine, provider, model } = engineFor(req.body);
    res.json({ ...(await engine.extractKeywords(req.body)), provider, model });
  }));

  /** Import keywords from an Excel workbook: send the .xlsx file itself as the request body. */
  router.post('/keywords/import', express.raw({ type: () => true, limit: '5mb' }), asyncRoute(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: 'Send the .xlsx file as the request body (not JSON).' });
    }
    // ?counts=adjacent: the column after the keywords holds prompt counts even without a "Prompts" heading.
    res.json(await readKeywordsFromXlsx(req.body, { adjacentCounts: req.query.counts === 'adjacent' }));
  }));

  router.post('/prompts/categorize', (req, res, next) => {
    try { res.json(createPromptEngine().categorize(req.body)); } catch (err) { next(err); }
  });

  router.post('/prompts/score', (req, res, next) => {
    try { res.json(createPromptEngine().score(req.body)); } catch (err) { next(err); }
  });

  /** Synchronous generation for small requests; larger ones should use POST /runs. */
  router.post('/prompts/generate', asyncRoute(async (req, res) => {
    const body = req.body || {};
    const expected = expectedPrompts(normalizeGenerateRequest(body)); // invalid input → 400 here
    if (expected > config.maxSyncPrompts) {
      return res.status(413).json({ error: `Requests over ${config.maxSyncPrompts} prompts must use POST /api/v1/runs (async).`, expected });
    }
    const { engine, provider, model } = engineFor(body);
    const ctrl = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
    const r = await engine.generate(body, { signal: ctrl.signal });
    res.json({ provider, model, ...r });
  }));

  // ── Async runs (persisted) ───────────────────────────────────────────────
  router.post('/runs', asyncRoute(async (req, res) => {
    const body = req.body || {};
    const { llm, provider, model } = llmFor(body);
    // Validate up-front with the engine's own rules, so bad input is a 400 now, not a failed run later.
    const s = normalizeGenerateRequest(body);
    const name = (typeof body.name === 'string' && body.name.trim().slice(0, 120)) ||
      `${s.brand.name || s.keywords[0] || s.brand.website} · ${new Date().toLocaleString('en-GB')}`;
    const run = await createRun({
      name, status: 'queued', origin: req.get('x-client') === 'ui' ? 'ui' : 'api', settings: s, prompts: [],
      target: expectedPrompts(s), provider, model,
    });
    enqueueRun(run.id, body, { llm, concurrency: config.concurrency, maxJobs: config.maxJobs });
    res.status(202).location(`/api/v1/runs/${run.id}`).json({ runId: run.id, status: 'queued', target: run.target, statusUrl: `/api/v1/runs/${run.id}` });
  }));

  router.get('/runs', asyncRoute(async (req, res) => {
    res.json(await listRuns(Math.min(Number(req.query.limit) || 30, 200)));
  }));

  router.get('/runs/:id', asyncRoute(async (req, res) => {
    let run = await getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (['queued', 'running', 'cancelling'].includes(run.status)) {
      // A run whose progress stopped moving was killed (serverless time limit, crash, redeploy).
      const lastBeat = run.progress?.updatedAt || new Date(run.updatedAt || run.createdAt).getTime();
      if (Date.now() - lastBeat > config.staleRunMs) {
        run = await updateRun(run.id, {
          status: 'failed',
          error: 'The run stopped responding (likely the server time limit). Try fewer keywords per run.',
          progress: null,
        });
        return res.json(run);
      }
      return res.json({ ...run, prompts: [], progress: jobProgress(run.id) || run.progress || null });
    }
    res.json(run);
  }));

  router.post('/runs/:id/cancel', asyncRoute(async (req, res) => {
    const run = await getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (!['queued', 'running'].includes(run.status)) return res.status(409).json({ error: `Run is already ${run.status}` });
    await cancelRun(run.id);
    if (run.status === 'queued') await updateRun(run.id, { status: 'cancelled', error: 'Cancelled' });
    res.json({ ok: true });
  }));

  const PromptList = z.array(z.object({
    id: z.string().min(1).max(64),
    text: z.string().trim().min(1).max(400),
    keyword: z.string().max(200).optional().default(''),
    category: z.enum(['Branded', 'Non-branded']),
    intent: z.string().max(40).optional().default(''),
    intentSource: z.string().max(20).optional(),
    sentiment: z.string().max(20).optional().default(''),
    score: z.number().min(0).max(100).optional(),
    grade: z.string().max(2).optional(),
    flags: z.array(z.string().max(40)).max(20).optional().default([]),
    topic: z.string().max(200).optional().default(''),
    location: z.string().max(100).optional().default(''),
    language: z.string().max(40).optional().default('English'),
    source: z.enum(['ai', 'template', 'fallback', 'custom']).default('custom'),
    selected: z.boolean().default(true),
  })).max(LIMITS.maxTotalPrompts + 2000);

  router.put('/runs/:id/prompts', asyncRoute(async (req, res) => {
    const parsed = PromptList.safeParse(req.body?.prompts);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid prompt list' });
    const run = await updateRun(req.params.id, { prompts: parsed.data });
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json({ ok: true, count: run.prompts.length });
  }));

  router.delete('/runs/:id', asyncRoute(async (req, res) => {
    await cancelRun(req.params.id).catch(() => {});
    res.status((await deleteRun(req.params.id)) ? 204 : 404).end();
  }));

  /** Download a run: ?format=xlsx|csv|json, ?all=1 to include unselected prompts. */
  router.get('/runs/:id/export', asyncRoute(async (req, res) => {
    const run = await getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const prompts = req.query.all ? run.prompts : run.prompts.filter((p) => p.selected !== false);
    await sendExport(res, run, prompts, String(req.query.format || 'xlsx'));
  }));

  /** Export an edited list from the UI (or any client) without saving it first. */
  router.post('/export', asyncRoute(async (req, res) => {
    const { runId, onlySelected = true, format = 'xlsx' } = req.body || {};
    const run = runId ? await getRun(runId) : null;
    const parsed = PromptList.safeParse(req.body?.prompts ?? run?.prompts);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid prompt list' });
    const prompts = onlySelected ? parsed.data.filter((p) => p.selected) : parsed.data;
    await sendExport(res, run || { name: 'prompts', settings: req.body?.settings || {} }, prompts, format);
  }));

  async function sendExport(res, run, prompts, format) {
    if (!prompts.length) return res.status(400).json({ error: 'Nothing to export. Select at least one prompt.' });
    if (format === 'json') return res.json({ name: run.name, settings: run.settings, profile: run.profile, prompts });
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName(run.name, 'csv')}"`);
      return res.send(`﻿${toCsv(prompts)}`);
    }
    const wb = await buildWorkbook({ run, prompts });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName(run.name, 'xlsx')}"`);
    await wb.xlsx.write(res);
    res.end();
  }

  return router;
}
