import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderRegistry, OFFLINE } from '../src/index.js';

/** Fake fetch that records the request and returns a canned body. */
function fakeFetch(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : null;
  const fn = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    const r = queue ? queue.shift() : responses;
    return new Response(JSON.stringify(r.body), { status: r.status || 200, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

const req = { system: 'SYS', user: 'USER', json: true, maxTokens: 100 };

test('registry falls back to offline with no keys', () => {
  const reg = createProviderRegistry({ env: {} });
  assert.equal(reg.defaultId(), OFFLINE);
  assert.equal(reg.get(), null);
  assert.ok(reg.list().every((p) => !p.configured));
});

test('registry honours LLM_PROVIDER and rejects unconfigured providers', () => {
  const reg = createProviderRegistry({ env: { OPENAI_API_KEY: 'a', GEMINI_API_KEY: 'g', LLM_PROVIDER: 'gemini' } });
  assert.equal(reg.defaultId(), 'gemini');
  assert.throws(() => reg.get('anthropic'), /not configured/);
  assert.throws(() => reg.get('nope'), /Unknown provider/);
});

test('openai adapter: Responses API shape', async () => {
  const f = fakeFetch({ body: { output: [{ content: [{ type: 'output_text', text: '{"ok":1}' }] }], usage: { input_tokens: 5, output_tokens: 7 } } });
  const llm = createProviderRegistry({ env: { OPENAI_API_KEY: 'k' }, fetchImpl: f }).get('openai', { model: 'gpt-x' });
  const r = await llm.complete(req);
  assert.equal(f.calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(f.calls[0].headers.authorization, 'Bearer k');
  assert.equal(f.calls[0].body.instructions, 'SYS');
  assert.deepEqual(f.calls[0].body.text, { format: { type: 'json_object' } });
  assert.equal(r.text, '{"ok":1}');
  assert.deepEqual([r.provider, r.model, r.usage.inputTokens, r.usage.outputTokens], ['openai', 'gpt-x', 5, 7]);
});

test('anthropic adapter: Messages API shape', async () => {
  const f = fakeFetch({ body: { content: [{ type: 'text', text: '{"ok":2}' }], usage: { input_tokens: 1, output_tokens: 2 } } });
  const llm = createProviderRegistry({ env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl: f }).get('anthropic');
  const r = await llm.complete(req);
  assert.equal(f.calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(f.calls[0].headers['x-api-key'], 'k');
  assert.equal(f.calls[0].body.model, 'claude-sonnet-5-5');
  assert.equal(f.calls[0].body.messages[0].content, 'USER');
  assert.equal(r.text, '{"ok":2}');
});

test('gemini adapter: generateContent shape', async () => {
  const f = fakeFetch({ body: { candidates: [{ content: { parts: [{ text: '{"ok":3}' }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 } } });
  const llm = createProviderRegistry({ env: { GEMINI_API_KEY: 'k' }, fetchImpl: f }).get('gemini');
  const r = await llm.complete(req);
  assert.match(f.calls[0].url, /models\/gemini-2\.5-flash:generateContent$/);
  assert.equal(f.calls[0].headers['x-goog-api-key'], 'k');
  assert.equal(f.calls[0].body.generationConfig.responseMimeType, 'application/json');
  assert.equal(r.text, '{"ok":3}');
  assert.equal(r.usage.outputTokens, 4);
});

test('openai-compatible presets and custom base URL', async () => {
  const body = { choices: [{ message: { content: '{"ok":4}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
  const f = fakeFetch(body && { body });
  const reg = createProviderRegistry({ env: { GROQ_API_KEY: 'g', CUSTOM_LLM_BASE_URL: 'https://llm.example.com/v1/', CUSTOM_LLM_MODEL: 'm1' }, fetchImpl: f });
  await reg.get('groq').complete(req);
  await reg.get('custom').complete(req);
  assert.equal(f.calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(f.calls[1].url, 'https://llm.example.com/v1/chat/completions');
  assert.equal(f.calls[1].body.model, 'm1');
  assert.equal(f.calls[1].headers.authorization, undefined);
});

test('retries 429 then succeeds; 401 is fatal and not retried', async () => {
  const ok = { body: { content: [{ type: 'text', text: 'x' }] } };
  const f = fakeFetch([{ status: 429, body: { error: { message: 'slow down' } } }, ok]);
  const reg = createProviderRegistry({ env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl: f, retry: { baseMs: 1 } });
  assert.equal((await reg.get('anthropic').complete(req)).text, 'x');
  assert.equal(f.calls.length, 2);

  const f2 = fakeFetch([{ status: 401, body: { error: { message: 'invalid x-api-key' } } }, ok]);
  const reg2 = createProviderRegistry({ env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl: f2, retry: { baseMs: 1 } });
  await assert.rejects(reg2.get('anthropic').complete(req), (e) => e.fatal && /invalid x-api-key/.test(e.message));
  assert.equal(f2.calls.length, 1);
});
