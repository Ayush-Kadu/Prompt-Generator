// Module: prompt quality scoring.
// A transparent, deterministic 0–100 score so prompts can be ranked, filtered
// and compared across providers. Each check contributes points and, when it
// fails, a flag that explains why.

import { brandMatcher, contentTokens, similarity, tokens } from '../text.js';

// Question words, requests, and first-person openings ("I run a…", "We export…", "As a student…"), which is how
// people describe their situation to an AI assistant.
const QUESTION_START = /^(what|which|who|how|why|where|when|is|are|can|could|should|does|do|will|would|best|top|compare|recommend|find|list|suggest|any|need|looking|i need|i want|i['’]?m|i am|i have|i run|i own|i work|i manage|i earn|i live|i plan|we|we['’]re|we are|our|my|as an?|for an?|help me|explain|tell me)\b/i;

export const SCORE_WEIGHTS = {
  keyword: 25,      // prompt is clearly about its keyword
  length: 15,       // natural length for a typed AI prompt
  natural: 15,      // reads like something a person asks
  specificity: 15,  // has a qualifier: audience, place, budget, use-case
  uniqueness: 20,   // not a near-duplicate of a sibling prompt
  compliance: 10,   // category matches brand rules
};

const SPECIFIC = /\b(for|in|near|under|below|within|with|without|during|budget|cheap|affordable|premium|same[- ]day|\d+|beginners?|kids?|families|small business(es)?|students?|enterprises?|wedding|office|home)\b/i;

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
 * Score one prompt.
 * @param {{text:string, keyword?:string, category?:string}} prompt
 * @param {{brand?:object, siblings?:string[]}} ctx  siblings = other prompts to check uniqueness against
 * @returns {{score:number, grade:'A'|'B'|'C'|'D', flags:string[], breakdown:object}}
 */
export function scorePrompt(prompt, ctx = {}) {
  const text = String(prompt.text || '');
  const words = tokens(text).length;
  const flags = [];
  const b = {};

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

  // A one- or two-word prompt is never a good prompt, whatever else it gets right.
  const raw = Object.values(b).reduce((a, v) => a + v, 0);
  const score = words < 3 ? Math.min(raw, 35) : raw;
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D';
  return { score, grade, flags, breakdown: b };
}

/** Score a list; uniqueness is checked against prompts sharing the same keyword. */
export function scorePrompts(prompts, { brand } = {}) {
  const byKeyword = new Map();
  for (const p of prompts) {
    const k = (p.keyword || '').toLowerCase();
    if (!byKeyword.has(k)) byKeyword.set(k, []);
    byKeyword.get(k).push(p.text);
  }
  return prompts.map((p) => {
    const { score, grade, flags } = scorePrompt(p, { brand, siblings: byKeyword.get((p.keyword || '').toLowerCase()) });
    return { ...p, score, grade, flags };
  });
}
