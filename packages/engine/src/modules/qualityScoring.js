// Module: prompt quality scoring.
// A transparent 0–100 score so prompts can be ranked, filtered and compared
// across providers. The biggest part is relevance: how closely the prompt
// relates to this business (its industry, offerings and customers). Each check
// contributes points and, when it fails, a flag that explains why.
//
// Relevance comes from one of two places:
// - "ai": a model rated the prompt against the business (see recommendations.js), stored on the prompt;
// - "context": a deterministic match against the business's own terms (industry, offerings, audience,
//   context, the run's other keywords), beyond the prompt's own keyword.
// When neither is possible (no business context at all), the score is computed from the other checks only.

import { brandMatcher, contentTokens, similarity, tokens } from '../text.js';

// Question words, requests, and first-person openings ("I run a…", "We export…", "As a student…"), which is how
// people describe their situation to an AI assistant.
const QUESTION_START = /^(what|which|who|how|why|where|when|is|are|can|could|should|does|do|will|would|best|top|compare|recommend|find|list|suggest|any|need|looking|i need|i want|i['’]?m|i am|i have|i run|i own|i work|i manage|i earn|i live|i plan|we|we['’]re|we are|our|my|as an?|for an?|help me|explain|tell me)\b/i;

export const SCORE_WEIGHTS = {
  relevance: 35,    // relates to this business: its industry, what it offers, who it serves
  keyword: 20,      // prompt is clearly about its keyword
  uniqueness: 15,   // not a near-duplicate of a sibling prompt
  natural: 10,      // reads like something a person asks
  specificity: 10,  // has a qualifier: audience, place, budget, use-case
  length: 5,        // natural length for a typed AI prompt
  compliance: 5,    // category matches brand rules
};

/** Below this relevance (0–1) a prompt is flagged "low-relevance". */
export const LOW_RELEVANCE = 0.4;

const SPECIFIC = /\b(for|in|near|under|below|within|with|without|during|budget|cheap|affordable|premium|same[- ]day|\d+|beginners?|kids?|families|small business(es)?|students?|enterprises?|wedding|office|home)\b/i;

/** Crude singular form, so "plants" matches "plant" and "companies" matches "company". */
const stem = (t) => (t.length > 3 ? t.replace(/ies$/, 'y').replace(/s$/, '') : t);

function keywordCoverage(text, keyword) {
  if (!keyword) return 1;
  const kw = contentTokens(keyword);
  if (!kw.length) return 1;
  const have = new Set(tokens(text));
  // allow simple plural / singular variants
  const hit = kw.filter((t) => have.has(t) || have.has(`${t}s`) || have.has(t.replace(/s$/, ''))).length;
  return hit / kw.length;
}

/**
 * The business's own vocabulary: industry, offerings, audience, description/context, topic and the
 * run's keywords. Brand name and aliases are left out (naming the brand is not relevance).
 * @returns {Set<string>}
 */
export function relevanceTerms({ brand, profile, context, topic, keywords } = {}) {
  const sources = [
    profile?.industry || brand?.industry,
    ...(profile?.offerings || []),
    ...(profile?.audience || []),
    ...(profile?.keywords || []),
    profile?.description || brand?.description,
    context,
    topic,
    ...(keywords || []),
  ];
  const brandWords = new Set(contentTokens([brand?.name, ...(brand?.aliases || [])].filter(Boolean).join(' ')).map(stem));
  const terms = new Set();
  for (const source of sources) {
    if (!source) continue;
    for (const t of contentTokens(source)) {
      const s = stem(t);
      if (!brandWords.has(s)) terms.add(s);
    }
  }
  return terms;
}

/**
 * Context match, 0–1: business terms the prompt uses beyond its own keyword (two or more = 1).
 * Null when the business vocabulary has nothing beyond the keyword, so relevance can't be judged.
 */
export function lexicalRelevance(text, keyword, terms) {
  if (!terms?.size) return null;
  const own = new Set(contentTokens(keyword || '').map(stem));
  if ([...terms].every((t) => own.has(t))) return null;
  const hits = new Set(contentTokens(text).map(stem).filter((t) => !own.has(t) && terms.has(t)));
  return Math.min(1, hits.size / 2);
}

/**
 * Score one prompt.
 * @param {{text:string, keyword?:string, category?:string, relevance?:number|null, relevanceSource?:string}} prompt
 *   relevance (0–100) with relevanceSource "ai" = a model's rating; it is used instead of the context match.
 * @param {{brand?:object, siblings?:string[], terms?:Set<string>}} ctx  siblings = other prompts to check
 *   uniqueness against; terms = relevanceTerms() for the business
 * @returns {{score:number, grade:'A'|'B'|'C'|'D', flags:string[], breakdown:object, relevance:number|null, relevanceSource:'ai'|'context'|'unknown'}}
 */
export function scorePrompt(prompt, ctx = {}) {
  const text = String(prompt.text || '');
  const words = tokens(text).length;
  const flags = [];
  const b = {};

  const rated = prompt.relevanceSource === 'ai' && typeof prompt.relevance === 'number';
  const rel = rated ? Math.max(0, Math.min(1, prompt.relevance / 100)) : lexicalRelevance(text, prompt.keyword, ctx.terms);
  const relevanceSource = rated ? 'ai' : rel === null ? 'unknown' : 'context';
  if (rel !== null) {
    b.relevance = Math.round(SCORE_WEIGHTS.relevance * rel);
    if (rel < LOW_RELEVANCE) flags.push('low-relevance');
  }

  const cov = keywordCoverage(text, prompt.keyword);
  b.keyword = Math.round(SCORE_WEIGHTS.keyword * cov);
  if (cov < 1) flags.push(cov === 0 ? 'missing-keyword' : 'partial-keyword');

  if (words >= 4 && words <= 25) b.length = SCORE_WEIGHTS.length;
  else if (words >= 3 && words <= 35) b.length = Math.round(SCORE_WEIGHTS.length / 2);
  else b.length = 0;
  if (words < 4) flags.push('too-short');
  if (words > 25) flags.push('too-long');

  const natural = QUESTION_START.test(text.trim()) || /\?\s*$/.test(text);
  b.natural = natural ? SCORE_WEIGHTS.natural : Math.round(SCORE_WEIGHTS.natural / 3);
  if (!natural) flags.push('keyword-stuffed');

  b.specificity = SPECIFIC.test(text) || words >= 9 ? SCORE_WEIGHTS.specificity : Math.round(SCORE_WEIGHTS.specificity / 3);
  if (b.specificity < SCORE_WEIGHTS.specificity) flags.push('generic');

  const maxSim = (ctx.siblings || []).reduce((m, s) => (s === text ? m : Math.max(m, similarity(text, s))), 0);
  b.uniqueness = maxSim >= 0.8 ? 0 : maxSim >= 0.6 ? Math.round(SCORE_WEIGHTS.uniqueness / 2) : SCORE_WEIGHTS.uniqueness;
  if (maxSim >= 0.6) flags.push('near-duplicate');

  const mentionsBrand = ctx.brand?.name ? brandMatcher(ctx.brand)(text) : false;
  const ok = !prompt.category || (prompt.category === 'Branded') === mentionsBrand;
  b.compliance = ok ? SCORE_WEIGHTS.compliance : 0;
  if (!ok) flags.push(mentionsBrand ? 'brand-leak' : 'brand-missing');

  // Relevance unknown → score out of the other checks' points, scaled to 0–100.
  const raw = Object.values(b).reduce((a, v) => a + v, 0);
  const scaled = rel === null ? Math.round((raw * 100) / (100 - SCORE_WEIGHTS.relevance)) : raw;
  // A one- or two-word prompt is never a good prompt, whatever else it gets right.
  const score = words < 3 ? Math.min(scaled, 35) : scaled;
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D';
  return { score, grade, flags, breakdown: b, relevance: rel === null ? null : Math.round(rel * 100), relevanceSource };
}

/** Score a list; uniqueness is checked against prompts sharing the same keyword. */
export function scorePrompts(prompts, { brand, terms } = {}) {
  const byKeyword = new Map();
  for (const p of prompts) {
    const k = (p.keyword || '').toLowerCase();
    if (!byKeyword.has(k)) byKeyword.set(k, []);
    byKeyword.get(k).push(p.text);
  }
  return prompts.map((p) => {
    const { score, grade, flags, relevance, relevanceSource } = scorePrompt(p, { brand, terms, siblings: byKeyword.get((p.keyword || '').toLowerCase()) });
    return { ...p, score, grade, flags, relevance, relevanceSource };
  });
}
