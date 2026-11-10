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
  intents: z.array(z.enum(Object.keys(INTENTS))).optional().default([]),
  sentiment: z.enum(Object.keys(SENTIMENTS)).default('neutral'),
  topic: text(200),
  context: text(LIMITS.maxContext),
  instruction: text(LIMITS.maxInstruction),
  location: text(100),
  language: z.enum(LANGUAGES).default('English'),
  /** Generate the full set once per language. Overrides `language` when non-empty. */
  languages: z.array(z.enum(LANGUAGES)).max(LANGUAGES.length).optional().default([]),
  promptsPerKeyword: z.number().int().min(1).max(LIMITS.maxPerKeyword).default(5),
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
  const expected = (keywords.length || r.autoKeywords) * r.promptsPerKeyword * languages.length;
  if (expected > LIMITS.maxTotalPrompts) {
    throw new EngineValidationError([`That is ${expected} prompts; the limit is ${LIMITS.maxTotalPrompts}. Reduce keywords, prompts per keyword or languages.`]);
  }
  return {
    ...r,
    brand,
    keywords,
    languages,
    language: languages[0],
    intents: [...new Set(r.intents)],
    topic: normalizeInstruction(r.topic, 200) || '',
    context: normalizeInstruction(r.context, LIMITS.maxContext),
    instruction: normalizeInstruction(r.instruction, LIMITS.maxInstruction),
    location: normalizeInstruction(r.location, 100) || brand.location || '',
  };
}
