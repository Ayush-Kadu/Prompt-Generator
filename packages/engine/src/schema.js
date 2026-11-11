// Input contracts for the engine. Every consumer (HTTP API, scripts, other
// apps importing the package) goes through the same validation.

import { z } from 'zod';
import { BRAND_MODES, INTENTS, LANGUAGES, LIMITS, SENTIMENTS } from './constants.js';
import { uniqueStrings } from './text.js';
import { normalizeInstruction } from './modules/instructions.js';

const text = (max) => z.string().max(max).optional().default('');
const list = (maxItems, maxLen = 100) => z.array(z.string().max(maxLen)).max(maxItems).optional().default([]);
const website = z.string().max(300).optional().default('')
  .refine((v) => !v || /^(https?:\/\/)?[^\s/]+\.[^\s]+$/i.test(v.trim()), 'must be a domain or http(s) URL');

export const BrandSchema = z.object({
  name: text(100),
  website,
  aliases: list(10),
  competitors: list(20),
  industry: text(200),
  description: text(LIMITS.maxContext),
  location: text(100),
}).default({});

export const AnalyzeBrandSchema = z.object({
  name: text(100),
  website,
  aliases: list(10),
  competitors: list(20),
  industry: text(200),
  description: text(LIMITS.maxContext),
  location: text(100),
}).refine((b) => b.website || b.description, 'Provide a website or a description');

export const ExtractKeywordsSchema = z.object({
  brand: BrandSchema,
  analyzeWebsite: z.boolean().default(true),
  seedKeywords: list(200, 120),
  limit: z.number().int().min(1).max(LIMITS.maxExtractKeywords).default(30),
  instruction: text(LIMITS.maxInstruction),
  language: z.enum(LANGUAGES).default('English'),
});

export const GenerateSchema = z.object({
  brand: BrandSchema,
  keywords: list(LIMITS.maxKeywords * 2, 200),
  /** When no keywords are given, extract this many from the brand profile / website. */
  autoKeywords: z.number().int().min(0).max(LIMITS.maxExtractKeywords).default(0),
  /** Fetch and analyse brand.website before generating (adds industry, offerings, audience). */
  analyzeWebsite: z.boolean().default(false),
  brandMode: z.enum(BRAND_MODES).default('non-branded'),
  brandedRatio: z.number().int().min(0).max(100).default(30),
  /** Mixed mode only: exact number of branded prompts in the total (per language). Overrides brandedRatio. */
  brandedCount: z.number().int().min(0).max(LIMITS.maxTotalPrompts).optional(),
  intents: z.array(z.enum(Object.keys(INTENTS))).optional().default([]),
  sentiment: z.enum(Object.keys(SENTIMENTS)).default('neutral'),
  /** Mixed sentiment only: exact numbers in the total (per language). `neutral` left out = the rest. */
  sentimentCounts: z.object({
    positive: z.number().int().min(0).max(LIMITS.maxTotalPrompts),
    negative: z.number().int().min(0).max(LIMITS.maxTotalPrompts),
    neutral: z.number().int().min(0).max(LIMITS.maxTotalPrompts).optional(),
  }).optional(),
  topic: text(200),
  context: text(LIMITS.maxContext),
  instruction: text(LIMITS.maxInstruction),
  location: text(100),
  language: z.enum(LANGUAGES).default('English'),
  /** Generate the full set once per language. Overrides `language` when non-empty. */
  languages: z.array(z.enum(LANGUAGES)).max(LANGUAGES.length).optional().default([]),
  promptsPerKeyword: z.number().int().min(1).max(LIMITS.maxPerKeyword).default(5),
  /** Optional count for individual keywords ({ "custom cakes": 10 }); others use promptsPerKeyword. Keys match case-insensitively. */
  promptsByKeyword: z.record(z.string().max(200), z.number().int().min(1).max(LIMITS.maxPerKeyword)).optional().default({})
    .refine((m) => Object.keys(m).length <= LIMITS.maxKeywords * 2, `at most ${LIMITS.maxKeywords * 2} entries`),
  /** Prompts scoring below this are rejected and re-requested (0 keeps all). */
  minQualityScore: z.number().int().min(0).max(100).default(0),
});

export const ScoreSchema = z.object({
  brand: BrandSchema,
  intents: z.array(z.enum(Object.keys(INTENTS))).optional().default([]),
  prompts: z.array(z.object({
    text: z.string().min(1).max(400),
    keyword: z.string().max(200).optional().default(''),
    category: z.enum(['Branded', 'Non-branded']).optional(),
    intent: z.string().max(40).optional(),
    sentiment: z.string().max(20).optional(),
  }).passthrough()).min(1).max(LIMITS.maxTotalPrompts),
});

export class EngineValidationError extends Error {
  constructor(issues) {
    super(`Invalid input: ${issues.join('; ')}`);
    this.name = 'EngineValidationError';
    this.status = 400;
    this.issues = issues;
  }
}

export function parse(schema, input) {
  const r = schema.safeParse(input ?? {});
  if (!r.success) throw new EngineValidationError(r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`));
  return r.data;
}

/** Normalise a brand object (trim, dedupe, clean free text). */
export function normalizeBrand(b = {}) {
  return {
    name: (b.name || '').trim(),
    website: (b.website || '').trim(),
    aliases: uniqueStrings(b.aliases),
    competitors: uniqueStrings(b.competitors),
    industry: normalizeInstruction(b.industry || '', 200),
    description: normalizeInstruction(b.description || '', LIMITS.maxContext),
    location: normalizeInstruction(b.location || '', 100),
  };
}

/** Prompts asked for one keyword: its own count when set, otherwise promptsPerKeyword. */
export function promptsFor(settings, keyword) {
  const map = settings.promptsByKeyword || {};
  return Object.hasOwn(map, keyword) ? map[keyword] : settings.promptsPerKeyword;
}

/**
 * Share `total` out over `sizes` in proportion to each size, as whole numbers that add
 * up to exactly `total` (largest-remainder method). No share exceeds its size.
 */
export function apportion(total, sizes) {
  const sum = sizes.reduce((a, n) => a + n, 0);
  const want = Math.max(0, Math.min(total, sum));
  if (!sum) return sizes.map(() => 0);
  const quotas = sizes.map((n) => (want * n) / sum);
  const shares = quotas.map(Math.floor);
  let left = want - shares.reduce((a, n) => a + n, 0);
  const byRemainder = quotas.map((q, i) => [q - shares[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of byRemainder) {
    if (left <= 0) break;
    shares[i]++;
    left--;
  }
  return shares;
}

/** Total prompts a normalised request asks for, across keywords and languages. */
export function expectedPrompts(s) {
  const perLanguage = s.keywords.length
    ? s.keywords.reduce((a, k) => a + promptsFor(s, k), 0)
    : s.autoKeywords * s.promptsPerKeyword;
  return perLanguage * (s.languages?.length || 1);
}

/** Validate + normalise a generate request. Business rules that zod can't express live here. */
export function normalizeGenerateRequest(input) {
  const r = parse(GenerateSchema, input);
  const brand = normalizeBrand(r.brand);
  const keywords = uniqueStrings(r.keywords, 120);
  if (keywords.length > LIMITS.maxKeywords) throw new EngineValidationError([`keywords: max ${LIMITS.maxKeywords}`]);
  if (!keywords.length && !r.autoKeywords) throw new EngineValidationError(['keywords: provide keywords or set autoKeywords']);
  if (!keywords.length && !brand.website && !brand.description && !brand.industry) {
    throw new EngineValidationError(['autoKeywords needs brand.website, brand.description or brand.industry']);
  }
  if (r.brandMode !== 'non-branded' && !brand.name) throw new EngineValidationError(['brand.name: required for branded and mixed modes']);
  const languages = r.languages.length ? [...new Set(r.languages)] : [r.language];
  // Re-key per-keyword counts to the keyword spellings kept above (same trim/case rules as uniqueStrings).
  const keyOf = (k) => String(k).replace(/\s+/g, ' ').trim().slice(0, 120).toLowerCase();
  const counts = new Map(Object.entries(r.promptsByKeyword).map(([k, n]) => [keyOf(k), n]));
  const promptsByKeyword = Object.fromEntries(keywords.filter((k) => counts.has(keyOf(k))).map((k) => [k, counts.get(keyOf(k))]));
  const expected = expectedPrompts({ keywords, autoKeywords: r.autoKeywords, promptsPerKeyword: r.promptsPerKeyword, promptsByKeyword, languages });
  if (expected > LIMITS.maxTotalPrompts) {
    throw new EngineValidationError([`That is ${expected} prompts; the limit is ${LIMITS.maxTotalPrompts}. Reduce keywords, prompts per keyword or languages.`]);
  }
  // An exact branded number only means something in mixed mode.
  const brandedCount = r.brandMode === 'mixed' && r.brandedCount !== undefined ? r.brandedCount : null;
  const perLanguage = expected / languages.length;
  if (brandedCount !== null && brandedCount > perLanguage) {
    throw new EngineValidationError([`brandedCount: ${brandedCount} is more than the ${perLanguage} prompts requested${languages.length > 1 ? ' per language' : ''}.`]);
  }
  // Exact sentiment numbers only mean something for mixed sentiment; they must add up to the total.
  let sentimentCounts = null;
  if (r.sentiment === 'mixed' && r.sentimentCounts) {
    const { positive, negative } = r.sentimentCounts;
    const neutral = r.sentimentCounts.neutral ?? perLanguage - positive - negative;
    const each = languages.length > 1 ? ' per language' : '';
    if (neutral < 0) {
      throw new EngineValidationError([`sentimentCounts: ${positive} positive + ${negative} negative is more than the ${perLanguage} prompts requested${each}.`]);
    }
    if (positive + negative + neutral !== perLanguage) {
      throw new EngineValidationError([`sentimentCounts: ${positive} + ${neutral} + ${negative} must add up to the ${perLanguage} prompts requested${each}.`]);
    }
    sentimentCounts = { positive, neutral, negative };
  }
  return {
    ...r,
    brand,
    keywords,
    languages,
    language: languages[0],
    promptsByKeyword,
    brandedCount,
    sentimentCounts,
    intents: [...new Set(r.intents)],
    topic: normalizeInstruction(r.topic, 200) || '',
    context: normalizeInstruction(r.context, LIMITS.maxContext),
    instruction: normalizeInstruction(r.instruction, LIMITS.maxInstruction),
    location: normalizeInstruction(r.location, 100) || brand.location || '',
  };
}
