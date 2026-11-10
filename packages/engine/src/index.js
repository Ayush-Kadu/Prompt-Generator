// @promptgen/engine — the reusable prompt-generation engine.
//
//   import { createPromptEngine } from '@promptgen/engine';
//   const engine = createPromptEngine({ llm });   // llm: any function matching ./llm.js, or omit for offline mode
//   const result = await engine.generate({ brand: { name: 'Acme', website: 'acme.com' }, keywords: ['crm'] });
//
// The engine has no provider code, no HTTP server and no database. Those live
// in @promptgen/providers and /server, so prompt intelligence can evolve here
// without touching them.

import { LIMITS } from './constants.js';
import { Usage, toLlmFn } from './llm.js';
import { analyzeBrand } from './modules/brandAnalysis.js';
import { categorizePrompts } from './modules/categorization.js';
import { extractKeywords } from './modules/keywordExtraction.js';
import { generateRecommendations } from './modules/recommendations.js';
import { scorePrompts } from './modules/qualityScoring.js';
import {
  AnalyzeBrandSchema, EngineValidationError, ExtractKeywordsSchema, ScoreSchema, normalizeBrand, normalizeGenerateRequest, parse,
} from './schema.js';
import { promptKey, uniqueStrings } from './text.js';

/** Merge per-language results into one: concatenated prompts, summed counters, recomputed totals. */
function mergeLanguageResults(results) {
  const seen = new Set();
  const prompts = [];
  const stats = {};
  let crossDuplicates = 0;
  for (const r of results) {
    for (const [k, v] of Object.entries(r.stats)) if (typeof v === 'number') stats[k] = (stats[k] || 0) + v;
    for (const p of r.prompts) {
      const key = promptKey(p.text);
      if (seen.has(key)) { crossDuplicates++; continue; } // e.g. English fallbacks repeated in every language
      seen.add(key);
      prompts.push(p);
    }
  }
  const byLanguage = {};
  for (const p of prompts) byLanguage[p.language] = (byLanguage[p.language] || 0) + 1;
  return {
    prompts,
    target: results.reduce((a, r) => a + r.target, 0),
    log: results.flatMap((r) => r.log),
    stats: {
      ...stats,
      duplicates: (stats.duplicates || 0) + crossDuplicates,
      total: prompts.length,
      branded: prompts.filter((p) => p.category === 'Branded').length,
      nonBranded: prompts.filter((p) => p.category === 'Non-branded').length,
      averageScore: prompts.length ? Math.round(prompts.reduce((a, p) => a + p.score, 0) / prompts.length) : 0,
      byLanguage,
    },
  };
}

export * from './constants.js';
export { EngineValidationError, GenerateSchema, AnalyzeBrandSchema, ExtractKeywordsSchema, ScoreSchema } from './schema.js';
export { normalizeInstruction } from './modules/instructions.js';
export { brandMatcher, promptKey } from './text.js';
export { inferIntent, inferSentiment } from './modules/categorization.js';
export { scorePrompt, SCORE_WEIGHTS } from './modules/qualityScoring.js';
export { extractSiteSignals } from './modules/brandAnalysis.js';
export { buildGenerationPrompt, GENERATION_SYSTEM } from './modules/recommendations.js';

export const ENGINE_VERSION = '1.0.0';

/**
 * @param {{llm?: Function|{complete:Function}, fetchImpl?: Function, concurrency?: number}} [options]
 */
export function createPromptEngine(options = {}) {
  const llm = toLlmFn(options.llm);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const concurrency = options.concurrency || 3;

  async function analyze(brand, usage) {
    const { profile, signals, warnings } = await analyzeBrand(brand, { llm, fetchImpl, usage });
    return { profile, signals, warnings };
  }

  return {
    version: ENGINE_VERSION,
    offline: !llm,

    /** Module: brand & website analysis. */
    async analyzeBrand(input) {
      const brand = normalizeBrand(parse(AnalyzeBrandSchema, input));
      const usage = new Usage();
      const { profile, warnings } = await analyze(brand, usage);
      return { profile, warnings, usage: usage.toJSON() };
    },

    /** Module: keyword extraction (optionally analysing the website first). */
    async extractKeywords(input) {
      const req = parse(ExtractKeywordsSchema, input);
      const brand = normalizeBrand(req.brand);
      const usage = new Usage();
      let profile = { ...brand, offerings: [], audience: [], keywords: [] };
      let signals = null;
      const warnings = [];
      if (req.analyzeWebsite && brand.website) {
        ({ profile, signals } = await analyze(brand, usage).then((r) => { warnings.push(...r.warnings); return r; }));
      }
      const out = await extractKeywords(
        { profile, signals, seeds: req.seedKeywords, limit: req.limit, instruction: req.instruction, language: req.language },
        { llm, usage },
      );
      return { keywords: out.keywords, source: out.source, profile, warnings: [...warnings, ...out.warnings], usage: usage.toJSON() };
    },

    /**
     * Full pipeline: [brand analysis] → [keyword extraction] → recommendations
     * (with categorization + quality scoring built in).
     * @param {object} input see GenerateSchema
     * @param {{onProgress?:Function, signal?:AbortSignal}} [hooks]
     */
    async generate(input, hooks = {}) {
      const settings = normalizeGenerateRequest(input);
      const usage = new Usage();
      const warnings = [];
      const say = (msg) => hooks.onProgress?.({ log: msg });
      let profile = null;
      let signals = null;
      if (!llm && settings.languages.some((l) => l !== 'English')) {
        const others = settings.languages.filter((l) => l !== 'English').join(', ');
        warnings.push(`No AI provider is configured, so prompts were written in English from templates. Configure a provider to generate ${others} prompts.`);
        settings.languages = ['English']; // templates would only repeat the same English prompts per language
        settings.language = 'English';
      }

      const needAnalysis = settings.brand.website && (settings.analyzeWebsite || !settings.keywords.length);
      if (needAnalysis) {
        say(`Analysing ${settings.brand.website}…`);
        ({ profile, signals } = await analyze(settings.brand, usage).then((r) => { warnings.push(...r.warnings); return r; }));
        settings.brand.competitors = uniqueStrings([...settings.brand.competitors, ...(profile.competitors || [])]).slice(0, 12);
        if (!settings.location && profile.location) settings.location = profile.location;
      }

      if (!settings.keywords.length) {
        say(`Extracting ${settings.autoKeywords} keywords…`);
        const out = await extractKeywords(
          { profile: profile || { ...settings.brand, offerings: [], audience: [], keywords: [] }, signals, limit: settings.autoKeywords, instruction: settings.instruction, language: settings.language },
          { llm, usage },
        );
        warnings.push(...out.warnings);
        settings.keywords = out.keywords.map((k) => k.keyword).slice(0, LIMITS.maxKeywords);
        if (!settings.keywords.length) throw new EngineValidationError(['Could not extract any keywords; please provide some.']);
        say(`Using ${settings.keywords.length} extracted keywords (${out.source}).`);
      }

      settings.profile = profile;
      // One full pass per language, one after another, so provider load stays at `concurrency`.
      const { languages } = settings;
      const perLanguage = settings.keywords.length * settings.promptsPerKeyword;
      const results = [];
      for (const [i, language] of languages.entries()) {
        const multi = languages.length > 1;
        if (multi) say(`Language ${i + 1}/${languages.length}: ${language}`);
        const before = results.reduce((a, r) => a + r.prompts.length, 0);
        results.push(await generateRecommendations({ ...settings, language }, {
          llm,
          usage,
          concurrency,
          signal: hooks.signal,
          onProgress: (p) => {
            if (!hooks.onProgress) return;
            if (p.log) return hooks.onProgress({ log: multi ? `[${language}] ${p.log}` : p.log });
            hooks.onProgress(multi
              ? { ...p, generated: before + p.generated, target: perLanguage * languages.length, language, languageIndex: i, languages: languages.length }
              : p);
          },
        }));
      }
      const result = results.length === 1 ? results[0] : mergeLanguageResults(results);
      const { profile: _p, ...publicSettings } = settings;
      return {
        prompts: result.prompts,
        keywords: settings.keywords,
        profile,
        target: result.target,
        stats: result.stats,
        log: result.log,
        warnings,
        usage: usage.toJSON(),
        settings: publicSettings,
      };
    },

    /** Module: categorization (branded/non-branded, intent, sentiment) for any prompt list. */
    categorize(input) {
      const req = parse(ScoreSchema, input);
      return { prompts: categorizePrompts(req.prompts, { brand: normalizeBrand(req.brand), intents: req.intents }) };
    },

    /** Module: quality scoring for any prompt list (categorizes first if category is missing). */
    score(input) {
      const req = parse(ScoreSchema, input);
      const brand = normalizeBrand(req.brand);
      const categorized = categorizePrompts(req.prompts, { brand, intents: req.intents })
        .map((p, i) => ({ ...p, category: req.prompts[i].category || p.category }));
      const prompts = scorePrompts(categorized, { brand });
      const averageScore = Math.round(prompts.reduce((a, p) => a + p.score, 0) / prompts.length);
      return { prompts, averageScore };
    },
  };
}
