// Module: prompt recommendations.
// The generation loop: plan → batch → generate → categorize & score each
// candidate → dedupe → top up shortfalls → fallback. It only knows the llm
// contract (see ../llm.js); provider details live in @promptgen/providers.

import { randomUUID } from 'node:crypto';
import { INTENTS, SENTIMENTS } from '../constants.js';
import { callJson } from '../llm.js';
import { promptsFor } from '../schema.js';
import { promptKey } from '../text.js';
import { createCategorizer } from './categorization.js';
import { SANDBOX_RULE, renderSteering } from './instructions.js';
import { offlineGenerate } from './offlineTemplates.js';
import { scorePrompt, scorePrompts } from './qualityScoring.js';

const PROMPTS_PER_CALL = 40;  // keep each reply small enough to stay reliable
const MAX_TOPUP_ROUNDS = 2;   // extra rounds that only ask for what is still missing
const AVOID_PER_KEYWORD = 15; // existing prompts shown to the model in top-up rounds

export const GENERATION_SYSTEM = `You are a search-behaviour analyst who writes realistic prompts that real people type into AI assistants (ChatGPT, Gemini, Perplexity, Claude) while researching a product or service.

Rules you always follow:
- Write natural, conversational queries a real customer would type. Vary length, phrasing and angle.
- Every prompt must be clearly about the keyword it is assigned to.
- No near-duplicates: two prompts that differ only by a word or punctuation count as the same prompt.
- A NON-BRANDED prompt must never mention the brand, its aliases or its website. Competitor names are allowed only for comparison or alternative prompts.
- A BRANDED prompt must mention the brand by name, naturally (e.g. reviews, pricing, "is <brand> good for", "<brand> vs ...").
- ${SANDBOX_RULE}
- Reply with JSON only. No prose, no code fences.`;

const line = (label, value) =>
  value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)
    ? null
    : `${label}: ${Array.isArray(value) ? value.join(', ') : value}`;

/** Build the user message for one batch. Exported so prompt changes can be unit-tested. */
export function buildGenerationPrompt(settings, batch) {
  const intents = settings.intents.length ? settings.intents : Object.keys(INTENTS);
  const { brand } = settings;
  const profile = settings.profile || {};
  const counts = [];
  if (batch.nonBranded > 0) counts.push(`${batch.nonBranded} NON-BRANDED prompt(s)`);
  if (batch.branded > 0) counts.push(`${batch.branded} BRANDED prompt(s) that mention "${brand.name}"`);

  const avoid = Object.entries(batch.avoid || {}).filter(([, l]) => l.length);
  return [
    '## Context',
    [
      line('Brand', brand.name),
      line('Brand website', brand.website),
      line('Brand aliases', brand.aliases),
      line('Industry', profile.industry || brand.industry),
      line('What the brand offers', profile.offerings),
      line('Typical customers', profile.audience),
      line('Known competitors', brand.competitors),
      line('Topic / category', settings.topic),
      line('Market location', settings.location),
      line('Write prompts in', settings.language),
    ].filter(Boolean).join('\n') || '(none provided)',
    renderSteering({ context: settings.context || profile.description || brand.description, instruction: null }),
    '',
    '## Keywords',
    batch.keywords.map((k, i) => `${i + 1}. ${k}`).join('\n'),
    '',
    '## Task',
    `For EACH keyword above, write exactly ${counts.join(' and ')}.`,
    `Spread the prompts across these search intents:\n${intents.map((i) => `  - ${i}: ${INTENTS[i]}`).join('\n')}`,
    `Sentiment / tone: ${settings.sentiment} — ${SENTIMENTS[settings.sentiment]}.`,
    settings.location ? `Where it fits, make some prompts specific to ${settings.location}.` : null,
    `Write every prompt in ${settings.language}.`,
    renderSteering({ context: null, instruction: settings.instruction }),
    avoid.length
      ? 'These prompts already exist. Do NOT repeat or paraphrase them:\n' +
        avoid.map(([kw, l]) => `[${kw}]\n${l.map((p) => `  - ${p}`).join('\n')}`).join('\n')
      : null,
    '',
    '## Output',
    'Return JSON in exactly this shape:',
    `{"prompts":[{"keyword":"<one of the keywords, copied exactly>","prompt":"<the query>","intent":"<${intents.join(' | ')}>","sentiment":"<positive | neutral | negative>"}]}`,
  ].filter((p) => p !== null && p !== '').join('\n');
}

async function pool(items, limit, worker, signal) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      if (signal?.aborted) throw Object.assign(new Error('Generation cancelled'), { name: 'AbortError' });
      const i = next++;
      await worker(items[i], i);
    }
  }));
}

function planBatches(needs) {
  const groups = new Map();
  for (const n of needs) {
    const sig = `${n.branded}|${n.nonBranded}`;
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(n.keyword);
  }
  const batches = [];
  for (const [sig, kws] of groups) {
    const [branded, nonBranded] = sig.split('|').map(Number);
    const size = Math.max(1, Math.floor(PROMPTS_PER_CALL / Math.max(1, branded + nonBranded)));
    for (let i = 0; i < kws.length; i += size) batches.push({ keywords: kws.slice(i, i + size), branded, nonBranded });
  }
  return batches;
}

function toCandidates(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.prompts) ? data.prompts : [];
  return list
    .map((item) => (typeof item === 'string' ? { prompt: item } : item))
    .filter((item) => item && typeof item.prompt === 'string' && item.prompt.trim())
    .map((item) => ({
      prompt: item.prompt.replace(/\s+/g, ' ').trim().slice(0, 400),
      keyword: typeof item.keyword === 'string' ? item.keyword.trim() : null,
      intent: item.intent,
      sentiment: item.sentiment,
    }));
}

/**
 * Generate prompts for normalised settings (see schema.normalizeGenerateRequest),
 * with settings.profile optionally holding a BrandProfile from brandAnalysis.
 * @param {object} settings
 * @param {{llm?:Function, usage?:import('../llm.js').Usage, onProgress?:Function, concurrency?:number, signal?:AbortSignal}} deps
 */
export async function generateRecommendations(settings, deps = {}) {
  const { llm, usage, signal } = deps;
  const onProgress = deps.onProgress || (() => {});
  const concurrency = deps.concurrency || 3;
  const log = [];
  const say = (msg) => { log.push({ at: new Date().toISOString(), msg }); onProgress({ log: msg }); };

  const brand = settings.brand;
  const hasBrand = Boolean(brand.name);
  const categorize = createCategorizer({ brand, intents: settings.intents });
  // Each keyword has its own count (promptsByKeyword, else promptsPerKeyword), split by the brand mode.
  const split = (n) => {
    let brandedTarget = 0;
    if (hasBrand && settings.brandMode === 'branded') brandedTarget = n;
    else if (hasBrand && settings.brandMode === 'mixed') brandedTarget = Math.round((n * settings.brandedRatio) / 100);
    return { brandedTarget, nonBrandedTarget: n - brandedTarget };
  };
  const minScore = settings.minQualityScore || 0;

  const buckets = new Map(settings.keywords.map((k) => [k.toLowerCase(), { keyword: k, ...split(promptsFor(settings, k)), branded: [], nonBranded: [] }]));
  const seen = new Set();
  const stats = { batches: 0, failedBatches: 0, rawCandidates: 0, duplicates: 0, wrongCategory: 0, lowQuality: 0, overflow: 0, unmatched: 0, fallback: 0 };
  const target = [...buckets.values()].reduce((a, b) => a + b.brandedTarget + b.nonBrandedTarget, 0);
  let generated = 0;

  const resolveBucket = (item, batchKeywords) => {
    const named = item.keyword && buckets.get(item.keyword.toLowerCase());
    if (named && batchKeywords.includes(named.keyword)) return named;
    const lower = item.prompt.toLowerCase();
    const hit = batchKeywords.find((k) => lower.includes(k.toLowerCase()));
    if (hit) return buckets.get(hit.toLowerCase());
    return batchKeywords.length === 1 ? buckets.get(batchKeywords[0].toLowerCase()) : null;
  };

  const accept = (item, batchKeywords, source) => {
    stats.rawCandidates++;
    const bucket = resolveBucket(item, batchKeywords);
    if (!bucket) { stats.unmatched++; return; }
    const key = promptKey(item.prompt);
    if (!key || seen.has(key)) { stats.duplicates++; return; }
    const cat = categorize(item.prompt, item);
    const branded = cat.category === 'Branded';
    if ((branded && !bucket.brandedTarget) || (!branded && !bucket.nonBrandedTarget)) { stats.wrongCategory++; return; }
    const list = branded ? bucket.branded : bucket.nonBranded;
    if (list.length >= (branded ? bucket.brandedTarget : bucket.nonBrandedTarget)) { stats.overflow++; return; }
    const siblings = [...bucket.branded, ...bucket.nonBranded].map((p) => p.text);
    const q = scorePrompt({ text: item.prompt, keyword: bucket.keyword, category: cat.category }, { brand, siblings });
    if (q.score < minScore) { stats.lowQuality++; return; }
    seen.add(key);
    generated++;
    list.push({
      id: randomUUID(),
      text: item.prompt,
      keyword: bucket.keyword,
      ...cat,
      topic: settings.topic || '',
      location: settings.location || '',
      language: source === 'ai' ? settings.language : 'English', // templates are English-only
      source,
      selected: true,
    });
  };

  const shortfalls = () => [...buckets.values()]
    .map((b) => ({
      keyword: b.keyword,
      branded: Math.max(0, b.brandedTarget - b.branded.length),
      nonBranded: Math.max(0, b.nonBrandedTarget - b.nonBranded.length),
    }))
    .filter((n) => n.branded + n.nonBranded > 0);

  const sizes = [...buckets.values()].map((b) => b.brandedTarget + b.nonBrandedTarget);
  const first = buckets.values().next().value;
  const shape = sizes.every((n) => n === sizes[0])
    ? `${first.nonBrandedTarget} non-branded + ${first.brandedTarget} branded each`
    : `${Math.min(...sizes)}–${Math.max(...sizes)} per keyword`;
  say(`Planning ${target} prompts for ${settings.keywords.length} keyword(s): ${shape}${llm ? '' : ' (offline templates — no LLM configured)'}.`);

  for (let round = 0; round <= MAX_TOPUP_ROUNDS; round++) {
    const needs = shortfalls();
    if (!needs.length) break;
    const batches = planBatches(needs);
    if (round > 0) {
      say(`Top-up round ${round}: ${needs.length} keyword(s) still short, ${batches.length} call(s).`);
      for (const b of batches) {
        b.avoid = Object.fromEntries(b.keywords.map((k) => {
          const bk = buckets.get(k.toLowerCase());
          return [k, [...bk.nonBranded, ...bk.branded].slice(-AVOID_PER_KEYWORD).map((p) => p.text)];
        }));
      }
    } else {
      say(`Generating in ${batches.length} batch(es), ${concurrency} at a time.`);
    }

    let done = 0;
    onProgress({ round, done, total: batches.length, generated, target });
    await pool(batches, llm ? concurrency : 8, async (batch) => {
      stats.batches++;
      try {
        let data;
        if (llm) {
          ({ data } = await callJson(llm, { system: GENERATION_SYSTEM, user: buildGenerationPrompt(settings, batch), maxTokens: 6000, signal }, usage));
        } else {
          data = offlineGenerate(settings, batch);
        }
        const items = toCandidates(data);
        if (!items.length) say(`A batch (${batch.keywords.slice(0, 3).join(', ')}…) returned no usable prompts.`);
        for (const item of items) accept(item, batch.keywords, llm ? 'ai' : 'template');
      } catch (err) {
        stats.failedBatches++;
        usage && usage.failedCalls++;
        say(`Batch failed (${batch.keywords.slice(0, 3).join(', ')}…): ${err.message}`);
        // Bad credentials, cancellation and engine bugs stop the run; transient provider errors don't.
        if (err.fatal || err.status === 401 || err.status === 403 || err.name === 'AbortError' || err instanceof TypeError || err instanceof ReferenceError) throw err;
      }
      done++;
      onProgress({ round, done, total: batches.length, generated, target });
    }, signal);
  }

  // Fallback: no keyword is ever left empty.
  for (const b of buckets.values()) {
    if (b.branded.length + b.nonBranded.length) continue;
    const branded = b.nonBrandedTarget === 0;
    const text = branded ? `is ${brand.name} good for ${b.keyword}` : `best ${b.keyword}${settings.location ? ` in ${settings.location}` : ''}`;
    if (seen.has(promptKey(text))) continue;
    seen.add(promptKey(text));
    stats.fallback++;
    (branded ? b.branded : b.nonBranded).push({
      id: randomUUID(), text, keyword: b.keyword, ...categorize(text, {}),
      topic: settings.topic || '', location: settings.location || '', language: 'English', source: 'fallback', selected: true,
    });
  }

  // Final score with full sibling context.
  const prompts = scorePrompts([...buckets.values()].flatMap((b) => [...b.nonBranded, ...b.branded]), { brand });
  const avg = prompts.length ? Math.round(prompts.reduce((a, p) => a + p.score, 0) / prompts.length) : 0;
  say(`Done: ${prompts.length}/${target} prompts, average quality ${avg}/100 (${stats.duplicates} duplicates, ${stats.wrongCategory} wrong-category, ${stats.lowQuality} low-quality dropped).`);

  return {
    prompts,
    target,
    stats: {
      ...stats,
      total: prompts.length,
      branded: prompts.filter((p) => p.category === 'Branded').length,
      nonBranded: prompts.filter((p) => p.category === 'Non-branded').length,
      averageScore: avg,
    },
    log,
  };
}
