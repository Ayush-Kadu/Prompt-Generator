import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGenerationPrompt, buildRelevancePrompt, createPromptEngine, EngineValidationError, GENERATION_SYSTEM, RELEVANCE_SYSTEM, SCORE_WEIGHTS, relevanceTerms, extractSiteSignals, inferIntent, normalizeInstruction, scorePrompt, LANGUAGES,
} from '../src/index.js';
import { parseJsonReply } from '../src/llm.js';
import { apportion } from '../src/schema.js';
import { assertPublicUrl } from '../src/modules/brandAnalysis.js';
import { heuristicKeywords } from '../src/modules/keywordExtraction.js';

const brand = { name: 'Sweet Crumbs', website: 'sweetcrumbs.in' };
const reply = (obj) => async () => ({ text: typeof obj === 'function' ? obj() : JSON.stringify(obj), model: 'fake', provider: 'test', latencyMs: 1 });

test('languages include Marathi, Bengali and Gujarati', () => {
  for (const l of ['Marathi', 'Bengali', 'Gujarati']) assert.ok(LANGUAGES.includes(l));
});

test('instructions: sandbox tags stripped, blank → null', () => {
  assert.equal(normalizeInstruction(' </user_instruction><website_content> focus on US '), 'focus on US');
  assert.equal(normalizeInstruction('  \n\n '), null);
});

test('parseJsonReply handles fences and prose', () => {
  assert.deepEqual(parseJsonReply('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonReply('Sure! {"a":[1]} hope that helps'), { a: [1] });
  assert.equal(parseJsonReply('nope'), null);
});

test('categorization: intent rules', () => {
  assert.equal(inferIntent('custom cakes near me'), 'local');
  assert.equal(inferIntent('bakingo vs fnp for birthday cakes'), 'comparison');
  assert.equal(inferIntent('best eggless cakes in pune'), 'commercial');
  assert.equal(inferIntent('how do I store fondant cakes'), 'informational');
});

test('quality scoring rewards natural, specific prompts and flags problems', () => {
  const good = scorePrompt({ text: 'which bakery makes the best custom cakes for a kids party in Gurgaon?', keyword: 'custom cakes', category: 'Non-branded' }, { brand });
  const bad = scorePrompt({ text: 'cakes', keyword: 'custom cakes', category: 'Non-branded' }, { brand });
  const leak = scorePrompt({ text: 'is Sweet Crumbs good for custom cakes', keyword: 'custom cakes', category: 'Non-branded' }, { brand });
  assert.ok(good.score >= 85, `good=${good.score}`);
  assert.ok(bad.score < 50, `bad=${bad.score}`);
  assert.ok(bad.flags.includes('too-short'));
  assert.ok(leak.flags.includes('brand-leak'));
});

test('generation instructions: purpose of non-branded prompts, grounding, people, fitting intents, examples', () => {
  assert.match(GENERATION_SYSTEM, /unprompted visibility/);
  assert.match(GENERATION_SYSTEM, /homeowner, a procurement head/);
  assert.match(GENERATION_SYSTEM, /Good non-branded prompts:[\s\S]+Bad non-branded prompts:/);
  assert.doesNotMatch(GENERATION_SYSTEM, /product or service/);

  const settings = {
    brand: { name: 'Sweet Crumbs', aliases: [], competitors: [], industry: 'Bakery' }, intents: [], sentiment: 'neutral',
    language: 'English', location: 'Pune', profile: { offerings: ['custom cakes'], audience: ['parents planning parties'] },
  };
  const batch = { keywords: ['eggless cakes'], branded: 0, nonBranded: 3 };
  const ask = buildGenerationPrompt(settings, batch);
  assert.match(ask, /Typical customers: parents planning parties/);
  assert.match(ask, /Ground every prompt in the context above/);
  assert.match(ask, /use only the ones that genuinely fit it/); // no intents chosen → the model picks fitting ones
  assert.doesNotMatch(ask, /Little is known about this business/);
  assert.match(buildGenerationPrompt({ ...settings, intents: ['commercial', 'local'] }, batch), /spread across each keyword's prompts as far as the keyword allows/);
  // With nothing known about the business, the model is told to infer the customers.
  assert.match(buildGenerationPrompt({ ...settings, brand: { ...settings.brand, industry: '' }, profile: null }, batch), /Little is known about this business/);
});

test('batches ask for about 20 prompts per call', async () => {
  const perCall = [];
  const llm = async ({ user }) => {
    const kws = [...user.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]);
    perCall.push(kws.length);
    const prompts = kws.flatMap((k) => [1, 2, 3, 4, 5].map((i) => ({ keyword: k, prompt: `which ${k} option suits a team of ${i}0 people?` })));
    return { text: JSON.stringify({ prompts }) };
  };
  const r = await createPromptEngine({ llm }).generate({ keywords: Array.from({ length: 10 }, (_, i) => `tool${i}`), promptsPerKeyword: 5, relevanceCheck: false });
  assert.equal(r.prompts.length, 50);
  assert.deepEqual(perCall, [4, 4, 2]); // 4 keywords × 5 = 20 prompts per call (was 8 × 5 = 40)
});

const WATER = {
  brand: { name: 'AquaClean', industry: 'Water and wastewater treatment' },
  profile: { offerings: ['sewage treatment plants', 'effluent treatment for industries'], audience: ['factory owners', 'municipal engineers'] },
};

test('relevance is the largest part of the score: context match against the business terms', () => {
  const terms = relevanceTerms({ ...WATER, keywords: ['sewage treatment plant'] });
  const kw = 'sewage treatment plant';
  const inContext = scorePrompt({ text: 'Which effluent and sewage treatment plant setup suits a textile factory with 300 workers?', keyword: kw }, { terms });
  const offContext = scorePrompt({ text: 'Is there a sewage treatment plant near the picnic spot for our school trip?', keyword: kw }, { terms });
  assert.equal(SCORE_WEIGHTS.relevance, 35);
  assert.equal(inContext.relevance, 100);
  assert.equal(inContext.relevanceSource, 'context');
  assert.equal(offContext.relevance, 0);
  assert.ok(offContext.flags.includes('low-relevance'));
  assert.ok(inContext.score - offContext.score >= 30, `${inContext.score} vs ${offContext.score}`);
  assert.ok(!relevanceTerms({ brand: { name: 'AquaClean' } }).has('aquaclean')); // the brand name is not relevance
  // Nothing known about the business → relevance unknown, score from the other checks only.
  const unknown = scorePrompt({ text: 'Which sewage treatment plant suits a 300-worker factory?', keyword: kw }, {});
  assert.equal(unknown.relevanceSource, 'unknown');
  assert.equal(unknown.relevance, null);
});

test('AI relevance check: off-topic prompts score low, fall under minQualityScore and get replaced', async () => {
  const calls = { generate: 0, rate: 0 };
  const llm = async ({ system, user }) => {
    if (system === RELEVANCE_SYSTEM) {
      calls.rate++;
      const lines = [...user.matchAll(/^\d+\. \[.*?\] (.+)$/gm)].map((m) => m[1]);
      return { text: JSON.stringify({ scores: lines.map((t) => (/factory|plant operator/i.test(t) ? 9 : 0)) }) };
    }
    calls.generate++;
    return { text: JSON.stringify({ prompts: [
      { keyword: 'sewage treatment plant', prompt: `Is there a sewage treatment plant near the picnic spot for school trip ${calls.generate}?` },
      { keyword: 'sewage treatment plant', prompt: `Can kids visit a sewage treatment plant during summer camp ${calls.generate}?` },
      { keyword: 'sewage treatment plant', prompt: `Which sewage treatment plant design suits a dairy factory with ${calls.generate}00 workers?` },
      { keyword: 'sewage treatment plant', prompt: `As a plant operator, how often should a sewage treatment plant of ${calls.generate} MLD be serviced?` },
    ] }) };
  };
  const r = await createPromptEngine({ llm }).generate({
    brand: WATER.brand, context: 'We build sewage and effluent treatment plants for factories.', keywords: ['sewage treatment plant'],
    promptsPerKeyword: 2, minQualityScore: 75,
  });
  assert.equal(r.prompts.length, 2);
  assert.ok(r.prompts.every((p) => p.relevanceSource === 'ai' && p.relevance === 90), JSON.stringify(r.prompts.map((p) => [p.text, p.relevance])));
  assert.ok(r.prompts.every((p) => /factory|plant operator/i.test(p.text)));
  assert.ok(r.stats.lowQuality >= 2);
  assert.equal(r.stats.averageRelevance, 90);
  assert.equal(calls.rate, calls.generate); // one rating call per batch
  assert.match(buildRelevancePrompt({ ...r.settings, profile: null }, [{ keyword: 'k', prompt: 'p' }]), /We build sewage and effluent/);

  // Unusable rating reply → the context match is used instead; relevanceCheck off → no rating calls at all.
  const garbage = async ({ system }) => ({ text: system === RELEVANCE_SYSTEM ? 'no idea' : JSON.stringify({ prompts: [{ keyword: 'sewage treatment plant', prompt: 'Which sewage treatment plant suits an effluent-heavy factory?' }] }) });
  const g = await createPromptEngine({ llm: garbage }).generate({ brand: WATER.brand, context: 'Effluent treatment for factories.', keywords: ['sewage treatment plant'], promptsPerKeyword: 1 });
  assert.equal(g.prompts[0].relevanceSource, 'context');
  assert.ok(g.stats.relevanceUnrated >= 1);
  let rated = 0;
  const counting = async ({ system }) => { if (system === RELEVANCE_SYSTEM) rated++; return garbage({ system }); };
  await createPromptEngine({ llm: counting }).generate({ keywords: ['sewage treatment plant'], promptsPerKeyword: 1, relevanceCheck: false });
  assert.equal(rated, 0);
});

test('natural phrasing accepts first-person prompts', () => {
  const s = scorePrompt({ text: 'We export 40 tonnes of grapes a month, what should we check in a cold storage provider', keyword: 'cold storage provider' });
  assert.ok(!s.flags.includes('keyword-stuffed'), s.flags.join());
  assert.ok(scorePrompt({ text: 'cold storage provider cheap price buy', keyword: 'cold storage provider' }).flags.includes('keyword-stuffed'));
});

test('validation errors are typed', async () => {
  const engine = createPromptEngine();
  await assert.rejects(engine.generate({ keywords: ['x'], brandMode: 'branded' }), EngineValidationError);
  await assert.rejects(engine.generate({}), /provide keywords or set autoKeywords/);
});

test('offline mode generates, categorizes and scores without any llm', async () => {
  const engine = createPromptEngine();
  assert.equal(engine.offline, true);
  const r = await engine.generate({ brand, keywords: ['custom cakes', 'cupcakes'], brandMode: 'mixed', brandedRatio: 50, promptsPerKeyword: 6, location: 'Gurgaon' });
  assert.equal(r.prompts.length, 12);
  assert.equal(r.stats.branded, 6);
  assert.ok(r.prompts.every((p) => typeof p.score === 'number' && p.intent && p.sentiment));
  assert.ok(r.prompts.every((p) => p.source === 'template'));
});

test('multiple languages: full set per language, tagged, counted and limited', async () => {
  // Fake model that writes in whatever language the batch asks for.
  const llm = async ({ user }) => {
    const lang = /Write every prompt in (.+)\./.exec(user)[1];
    const kws = [...user.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]);
    const prompts = kws.flatMap((k) => [1, 2, 3].map((i) => ({ keyword: k, prompt: `which ${k} option suits use case ${i} for ${lang} speakers?` })));
    return { text: JSON.stringify({ prompts }) };
  };
  const progress = [];
  const r = await createPromptEngine({ llm }).generate(
    { keywords: ['crm software', 'email tools'], promptsPerKeyword: 3, languages: ['English', 'Hindi', 'English'] },
    { onProgress: (p) => { if (!p.log) progress.push(p); } },
  );
  assert.deepEqual(r.settings.languages, ['English', 'Hindi']);
  assert.equal(r.target, 12);
  assert.equal(r.prompts.length, 12);
  assert.deepEqual(r.stats.byLanguage, { English: 6, Hindi: 6 });
  assert.ok(r.prompts.filter((p) => p.language === 'Hindi').every((p) => p.text.includes('Hindi')));
  assert.deepEqual([progress.at(-1).generated, progress.at(-1).target], [12, 12]);

  const many = { keywords: Array.from({ length: 1000 }, (_, i) => `k${i}`), promptsPerKeyword: 5, languages: ['English', 'Hindi', 'Marathi'] };
  await assert.rejects(createPromptEngine({ llm }).generate(many), /15000 prompts/);
});

test('per-keyword prompt counts override the default; branded split and limits follow them', async () => {
  const engine = createPromptEngine();
  const r = await engine.generate({
    brand, keywords: ['custom cakes', 'cupcakes', 'eggless cakes'], promptsPerKeyword: 2,
    promptsByKeyword: { ' CUPCAKES ': 6, 'eggless cakes': 4, 'not a keyword': 9 }, brandMode: 'mixed', brandedRatio: 50,
  });
  const count = (k) => r.prompts.filter((p) => p.keyword === k).length;
  assert.deepEqual([count('custom cakes'), count('cupcakes'), count('eggless cakes')], [2, 6, 4]);
  assert.equal(r.target, 12);
  assert.deepEqual(r.settings.promptsByKeyword, { cupcakes: 6, 'eggless cakes': 4 }); // re-keyed to the kept spelling; unknown keys dropped
  assert.equal(r.prompts.filter((p) => p.keyword === 'cupcakes' && p.category === 'Branded').length, 3);

  // The total limit counts per-keyword numbers: 400 × 25 = 10,000 is fine, one more prompt is not.
  const kws = Array.from({ length: 401 }, (_, i) => `k${i}`);
  const counts = Object.fromEntries(kws.slice(0, 400).map((k) => [k, 25]));
  await assert.rejects(engine.generate({ keywords: kws, promptsPerKeyword: 1, promptsByKeyword: counts }), /10001 prompts/);
  await assert.rejects(engine.generate({ keywords: ['a'], promptsByKeyword: { a: 26 } }), EngineValidationError);
});

test('mixed mode with an exact branded number: exact total, shared in proportion to keyword counts', async () => {
  const engine = createPromptEngine();
  const base = { brand, keywords: ['custom cakes', 'cupcakes', 'eggless cakes'], promptsPerKeyword: 2, promptsByKeyword: { cupcakes: 6, 'eggless cakes': 4 }, brandMode: 'mixed' };
  const r = await engine.generate({ ...base, brandedCount: 5 });
  const branded = (k) => r.prompts.filter((p) => p.keyword === k && p.category === 'Branded').length;
  assert.equal(r.stats.branded, 5);
  assert.equal(r.stats.nonBranded, 7);
  // Quotas 0.83 / 2.5 / 1.67 → 0 / 2 / 1, then the two largest remainders (custom cakes, eggless cakes) get one more.
  assert.deepEqual([branded('custom cakes'), branded('cupcakes'), branded('eggless cakes')], [1, 2, 2]);

  assert.equal((await engine.generate({ ...base, brandedCount: 0 })).stats.branded, 0);
  assert.equal((await engine.generate({ ...base, brandedCount: 12 })).stats.nonBranded, 0);
  await assert.rejects(engine.generate({ ...base, brandedCount: 13 }), /more than the 12 prompts/);
  // Outside mixed mode the number is ignored.
  assert.equal((await engine.generate({ ...base, brandMode: 'non-branded', brandedCount: 5 })).stats.branded, 0);
});

test('mixed sentiment with exact numbers: exact totals, each keyword still gets its own count', async () => {
  const engine = createPromptEngine();
  const base = {
    brand, keywords: ['custom cakes', 'cupcakes', 'eggless cakes'], promptsPerKeyword: 2, promptsByKeyword: { cupcakes: 6, 'eggless cakes': 4 },
    brandMode: 'mixed', brandedCount: 5, sentiment: 'mixed',
  };
  const r = await engine.generate({ ...base, sentimentCounts: { positive: 3, negative: 4 } }); // neutral = the rest (5)
  assert.deepEqual(r.stats.bySentiment, { positive: 3, neutral: 5, negative: 4 });
  assert.equal(r.stats.branded, 5);
  const count = (k) => r.prompts.filter((p) => p.keyword === k).length;
  assert.deepEqual([count('custom cakes'), count('cupcakes'), count('eggless cakes')], [2, 6, 4]);
  assert.deepEqual(r.settings.sentimentCounts, { positive: 3, neutral: 5, negative: 4 });

  assert.deepEqual((await engine.generate({ ...base, sentimentCounts: { positive: 0, negative: 12 } })).stats.bySentiment, { positive: 0, neutral: 0, negative: 12 });
  await assert.rejects(engine.generate({ ...base, sentimentCounts: { positive: 8, negative: 5 } }), /more than the 12 prompts/);
  await assert.rejects(engine.generate({ ...base, sentimentCounts: { positive: 3, negative: 4, neutral: 1 } }), /must add up to the 12/);
  // The model is asked for exact counts per brand group and sentiment.
  const ask = buildGenerationPrompt({ ...r.settings, profile: null }, {
    keywords: ['cupcakes'], branded: 2, nonBranded: 4,
    cells: { branded: { positive: 1, neutral: 1, negative: 0 }, nonBranded: { positive: 0, neutral: 3, negative: 1 } },
  });
  assert.match(ask, /3 NON-BRANDED NEUTRAL, 1 NON-BRANDED NEGATIVE, 1 BRANDED \(mention "Sweet Crumbs"\) POSITIVE, 1 BRANDED \(mention "Sweet Crumbs"\) NEUTRAL\./);
  // Other sentiments ignore the numbers.
  const neutralRun = await engine.generate({ ...base, sentiment: 'neutral', sentimentCounts: { positive: 3, negative: 4 } });
  assert.equal(neutralRun.settings.sentimentCounts, null);
});

test('apportion shares a total exactly and never over a size', () => {
  assert.deepEqual(apportion(5, [2, 6, 4]), [1, 2, 2]);
  assert.deepEqual(apportion(3, [1, 1, 1, 1]), [1, 1, 1, 0]);
  assert.deepEqual(apportion(99, [2, 3]), [2, 3]);
  assert.deepEqual(apportion(4, [0, 0]), [0, 0]);
});

test('offline mode collapses multiple languages to English with a warning', async () => {
  const r = await createPromptEngine().generate({ keywords: ['cupcakes'], promptsPerKeyword: 3, languages: ['Hindi', 'English'] });
  assert.equal(r.prompts.length, 3);
  assert.ok(r.prompts.every((p) => p.language === 'English'));
  assert.match(r.warnings.join(), /Hindi/);
});

test('generation: drops brand leaks, dedupes, tops up, tracks usage', async () => {
  let call = 0;
  const llm = reply(() => {
    call++;
    return JSON.stringify({ prompts: [
      { keyword: 'custom cakes', prompt: 'best custom cakes in Gurgaon' },
      { keyword: 'custom cakes', prompt: 'Best custom cakes in Gurgaon!' },
      { keyword: 'custom cakes', prompt: 'is Sweet Crumbs good for custom cakes' },
      { keyword: 'custom cakes', prompt: `where to order custom cakes for a party of ${call}0 people` },
      { keyword: 'birthday cakes', prompt: `which birthday cakes suit a ${call} year old` },
    ] });
  });
  const engine = createPromptEngine({ llm });
  const r = await engine.generate({ brand, keywords: ['custom cakes', 'birthday cakes'], promptsPerKeyword: 2 });
  assert.equal(r.prompts.length, 4);
  assert.ok(r.prompts.every((p) => p.category === 'Non-branded'));
  assert.ok(r.stats.duplicates >= 1 && r.stats.wrongCategory >= 1);
  assert.equal(r.usage.calls, call);
  assert.ok(call >= 2, 'top-up round ran');
});

test('minQualityScore rejects weak prompts', async () => {
  const llm = reply({ prompts: [{ keyword: 'cupcakes', prompt: 'cupcakes' }, { keyword: 'cupcakes', prompt: 'where can I order vegan cupcakes for an office party?' }] });
  const r = await createPromptEngine({ llm }).generate({ keywords: ['cupcakes'], promptsPerKeyword: 2, minQualityScore: 60 });
  assert.ok(r.prompts.every((p) => p.text !== 'cupcakes'));
  assert.ok(r.stats.lowQuality >= 1);
});

test('fallback keeps every keyword non-empty', async () => {
  const r = await createPromptEngine({ llm: reply(() => 'garbage') }).generate({ keywords: ['custom cakes'], location: 'Pune' });
  assert.equal(r.prompts[0].text, 'best custom cakes in Pune');
  assert.equal(r.prompts[0].source, 'fallback');
});

test('provider errors with 401 stop the run', async () => {
  const llm = async () => { throw Object.assign(new Error('bad key'), { status: 401 }); };
  await assert.rejects(createPromptEngine({ llm }).generate({ keywords: ['a', 'b'] }), /bad key/);
});

const HTML = `<html><head><title>Sweet Crumbs | Custom Cakes Gurgaon</title>
<meta name="description" content="Designer custom cakes, cupcakes and eggless cakes delivered across Gurgaon.">
<script>var x = 1;</script></head><body><h1>Custom birthday cakes</h1><h2>Eggless cakes &amp; cupcakes</h2>
<p>Order custom cakes online. Same day delivery of birthday cakes and eggless cakes in Gurgaon.</p></body></html>`;

test('brand analysis: site signals + heuristic keywords', () => {
  const s = extractSiteSignals(HTML);
  assert.equal(s.title, 'Sweet Crumbs | Custom Cakes Gurgaon');
  assert.match(s.description, /Designer custom cakes/);
  assert.deepEqual(s.headings, ['Custom birthday cakes', 'Eggless cakes & cupcakes']);
  assert.ok(!s.text.includes('var x'));
  const kws = heuristicKeywords({ profile: brand, signals: s, limit: 10 });
  assert.ok(kws.some((k) => k.includes('eggless cakes')), kws.join(','));
  assert.ok(kws.every((k) => !k.includes('sweet crumbs')));
});

test('brand analysis blocks private addresses (SSRF guard)', async () => {
  await assert.rejects(assertPublicUrl('http://127.0.0.1/admin'), /not allowed/);
  await assert.rejects(assertPublicUrl('http://192.168.1.10'), /not allowed/);
  await assert.rejects(assertPublicUrl('file:///etc/passwd'), /Only http/);
});

test('analyzeBrand + extractKeywords use the injected llm and fetch', async () => {
  const fetchImpl = async () => new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } });
  const llm = async ({ user }) => ({
    text: user.includes('"keywords":[{')
      ? JSON.stringify({ keywords: [{ keyword: 'eggless cakes', type: 'product' }, { keyword: 'sweet crumbs cakes' }, { keyword: 'cake delivery gurgaon', type: 'location' }] })
      : JSON.stringify({ name: 'Sweet Crumbs', industry: 'Bakery', offerings: ['custom cakes'], audience: ['parents'], competitors: ['Bakingo'], keywords: [] }),
  });
  const engine = createPromptEngine({ llm, fetchImpl });
  const a = await engine.analyzeBrand({ website: 'https://example.com' });
  assert.equal(a.profile.industry, 'Bakery');
  assert.equal(a.profile.source, 'llm');
  const k = await engine.extractKeywords({ brand: { name: 'Sweet Crumbs', website: 'https://example.com' }, limit: 5 });
  assert.deepEqual(k.keywords.map((x) => x.keyword), ['eggless cakes', 'cake delivery gurgaon']); // branded keyword removed
});

test('score() and categorize() work on external prompt lists', () => {
  const engine = createPromptEngine();
  const s = engine.score({ brand, prompts: [{ text: 'best custom cakes in Gurgaon for weddings', keyword: 'custom cakes' }, { text: 'Sweet Crumbs reviews', keyword: '' }] });
  assert.equal(s.prompts[1].category, 'Branded');
  assert.equal(s.prompts[1].intent, 'review');
  assert.ok(s.averageScore > 0);
});
