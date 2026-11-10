import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { createProviderRegistry } from '@promptgen/providers';
import { createApp } from '../src/app.js';

/** Spin the app up on a random port with a fake provider behind it. */
async function start(env = {}) {
  // Fake "openai" endpoint: returns prompts that echo the requested keywords.
  const fetchImpl = async (_url, init) => {
    const { input } = JSON.parse(init.body);
    const kws = [...input.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]);
    const prompts = kws.flatMap((k) => [1, 2, 3, 4, 5, 6].map((i) => ({ keyword: k, prompt: `which ${k} option is best for use case ${i} in Pune?` })));
    return new Response(JSON.stringify({ output_text: JSON.stringify({ prompts }), usage: { input_tokens: 10, output_tokens: 20 } }), { status: 200 });
  };
  const fullEnv = { OPENAI_API_KEY: 'test', RATE_LIMIT_PER_MINUTE: '0', ...env };
  const { app } = createApp({ env: fullEnv, registry: createProviderRegistry({ env: fullEnv, fetchImpl }) });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = (path, { method = 'GET', body, headers = {} } = {}) =>
    fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  return { server, call };
}

test('meta lists providers, languages and the default provider', async (t) => {
  const { server, call } = await start();
  t.after(() => server.close());
  const meta = await (await call('/meta')).json();
  assert.equal(meta.defaultProvider, 'openai');
  assert.ok(meta.providers.find((p) => p.id === 'gemini'));
  assert.ok(['Marathi', 'Bengali', 'Gujarati'].every((l) => meta.languages.includes(l)));
});

test('sync generate through a provider adapter', async (t) => {
  const { server, call } = await start();
  t.after(() => server.close());
  const res = await call('/prompts/generate', { method: 'POST', body: { keywords: ['crm software', 'email tools'], promptsPerKeyword: 3, brand: { name: 'Acme' } } });
  const r = await res.json();
  assert.equal(res.status, 200, JSON.stringify(r));
  assert.equal(r.provider, 'openai');
  assert.equal(r.prompts.length, 6);
  assert.ok(r.prompts.every((p) => p.score > 0 && p.category === 'Non-branded'));
  assert.equal(r.usage.inputTokens, 10);
});

test('offline provider can be chosen per request; unknown provider is a 400', async (t) => {
  const { server, call } = await start();
  t.after(() => server.close());
  const r = await (await call('/prompts/generate', { method: 'POST', body: { provider: 'offline', keywords: ['crm'], promptsPerKeyword: 2 } })).json();
  assert.equal(r.provider, 'offline');
  assert.ok(r.prompts.every((p) => p.source === 'template'));
  assert.equal((await call('/prompts/generate', { method: 'POST', body: { provider: 'nope', keywords: ['crm'] } })).status, 400);
  assert.equal((await call('/prompts/generate', { method: 'POST', body: { provider: 'gemini', keywords: ['crm'] } })).status, 400);
});

test('validation errors are 400 with details; big sync requests are 413', async (t) => {
  const { server, call } = await start();
  t.after(() => server.close());
  const bad = await call('/prompts/generate', { method: 'POST', body: { keywords: ['x'], brandMode: 'branded' } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).details.join(), /brand.name/);
  const big = await call('/prompts/generate', { method: 'POST', body: { keywords: Array.from({ length: 200 }, (_, i) => `k${i}`), promptsPerKeyword: 5 } });
  assert.equal(big.status, 413);
});

test('async run → poll → edit → export xlsx/csv', async (t) => {
  const { server, call } = await start();
  t.after(() => server.close());
  const start202 = await call('/runs', { method: 'POST', body: { keywords: ['crm software', 'email tools', 'invoicing'], promptsPerKeyword: 4, language: 'Marathi' } });
  assert.equal(start202.status, 202);
  const { runId } = await start202.json();
  let run;
  for (let i = 0; i < 50; i++) {
    run = await (await call(`/runs/${runId}`)).json();
    if (!['queued', 'running'].includes(run.status)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(run.status, 'done', run.error);
  assert.equal(run.prompts.length, 12);
  assert.equal(run.prompts[0].language, 'Marathi');

  run.prompts[0].selected = false;
  assert.equal((await call(`/runs/${runId}/prompts`, { method: 'PUT', body: { prompts: run.prompts } })).status, 200);

  const x = await call(`/runs/${runId}/export?format=xlsx`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await x.arrayBuffer()));
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Prompts', 'Summary', 'Settings']);
  assert.equal(wb.getWorksheet('Prompts').rowCount, 12); // header + 11 selected
  assert.equal(wb.getWorksheet('Prompts').getRow(1).getCell(7).value, 'Quality score');

  const csv = await (await call(`/runs/${runId}/export?format=csv&all=1`)).text();
  assert.equal(csv.trim().split('\r\n').length, 13);
});

test('API keys are enforced when configured', async (t) => {
  const { server, call } = await start({ ENGINE_API_KEYS: 'secret-1,secret-2' });
  t.after(() => server.close());
  assert.equal((await call('/meta')).status, 401);
  assert.equal((await call('/meta', { headers: { authorization: 'Bearer secret-2' } })).status, 200);
  assert.equal((await call('/meta', { headers: { 'x-api-key': 'secret-1' } })).status, 200);
  assert.equal((await call('/health')).status, 200);
});

test('score endpoint works on prompts from another app', async (t) => {
  const { server, call } = await start();
  t.after(() => server.close());
  const r = await (await call('/prompts/score', { method: 'POST', body: { brand: { name: 'Acme' }, prompts: [{ text: 'Acme reviews from small businesses', keyword: '' }, { text: 'crm', keyword: 'crm' }] } })).json();
  assert.equal(r.prompts[0].category, 'Branded');
  assert.ok(r.prompts[1].score < 50);
});
