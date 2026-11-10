// Module: keyword extraction.
// Produces non-branded search keywords for a brand, from its profile, website
// signals and any seed keywords. Uses the llm when available; otherwise a
// phrase-frequency heuristic over headings, offerings and page text.

import { LIMITS } from '../constants.js';
import { callJson } from '../llm.js';
import { STOPWORDS, brandMatcher, tokens, uniqueStrings } from '../text.js';
import { SANDBOX_RULE, normalizeInstruction, sandbox } from './instructions.js';

const SYSTEM = `You are an SEO and AI-search keyword researcher. You list the non-branded keywords and short phrases real customers use when looking for the kind of products or services a business offers.
Keywords are 1–4 words, lowercase, specific, and never contain the brand's own name. ${SANDBOX_RULE}
Reply with JSON only.`;

const NOISE = new Set(['home', 'about', 'contact', 'login', 'sign', 'menu', 'cart', 'blog', 'faq', 'privacy', 'terms', 'policy', 'cookies', 'copyright', 'rights', 'reserved', 'search', 'click', 'read', 'learn', 'welcome',
  'get', 'started', 'quick', 'easy', 'latest', 'news', 'docs', 'more', 'new', 'now', 'find', 'see', 'view', 'use', 'using', 'make',
  'take', 'free', 'expect', 'defined', 'join', 'follow', 'share', 'download', 'subscribe', 'page', 'site', 'website', 'today']);

/** Frequency-ranked 1–3 word phrases. */
export function heuristicKeywords({ profile, signals, seeds = [], limit = 30 }) {
  const isBrand = brandMatcher(profile);
  const scores = new Map();
  const add = (phrase, weight) => {
    if (!phrase || isBrand(phrase)) return;
    scores.set(phrase, (scores.get(phrase) || 0) + weight);
  };
  const harvest = (text, weight) => {
    const words = tokens(text).filter((w) => !/^\d+$/.test(w));
    for (let n = 1; n <= 3; n++) {
      for (let i = 0; i + n <= words.length; i++) {
        const gram = words.slice(i, i + n);
        if (STOPWORDS.has(gram[0]) || STOPWORDS.has(gram[n - 1]) || gram.some((w) => NOISE.has(w) || w.length < 3)) continue;
        add(gram.join(' '), weight * (n === 1 ? 0.6 : n === 2 ? 1.4 : 1.1));
      }
    }
  };
  seeds.forEach((s) => add(s.toLowerCase(), 100));
  (profile?.keywords || []).forEach((k) => add(k.toLowerCase(), 50));
  (profile?.offerings || []).forEach((o) => harvest(o, 6));
  (signals?.keywordsMeta || []).forEach((k) => add(k.toLowerCase(), 20));
  (signals?.headings || []).forEach((h) => harvest(h, 4));
  if (signals?.text) harvest(signals.text, 1);
  if (profile?.industry) add(profile.industry.toLowerCase(), 30);

  return [...scores.entries()]
    .filter(([, s]) => s >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k)
    .filter((k, _, all) => !all.some((o) => o !== k && o.includes(k) && scores.get(o) >= scores.get(k))) // prefer longer phrase
    .slice(0, limit);
}

/**
 * @param {{profile:object, signals?:object, seeds?:string[], limit?:number, instruction?:string|null, language?:string}} input
 * @param {{llm?:Function, usage?:object}} deps
 * @returns {Promise<{keywords:{keyword:string, type:string}[], source:'llm'|'heuristic', warnings:string[]}>}
 */
export async function extractKeywords(input, { llm, usage } = {}) {
  const limit = Math.min(Math.max(1, input.limit || 30), LIMITS.maxExtractKeywords);
  const seeds = uniqueStrings(input.seeds || []);
  const isBrand = brandMatcher(input.profile);
  const warnings = [];
  const fallback = () => ({
    keywords: heuristicKeywords({ ...input, seeds, limit }).map((keyword) => ({ keyword, type: 'extracted' })),
    source: 'heuristic',
    warnings,
  });
  if (!llm) return fallback();

  const p = input.profile || {};
  const siteText = normalizeInstruction([
    input.signals?.headings?.length && `Headings: ${input.signals.headings.join(' | ')}`,
    input.signals?.text && `Text: ${input.signals.text.slice(0, 3000)}`,
  ].filter(Boolean).join('\n'), 4000);
  const instruction = normalizeInstruction(input.instruction || '');

  const user = [
    '## Brand profile',
    p.name && `Brand (never include in keywords): ${p.name}`,
    p.industry && `Industry: ${p.industry}`,
    p.description && `Description: ${p.description}`,
    p.offerings?.length && `Offerings: ${p.offerings.join(', ')}`,
    p.audience?.length && `Audience: ${p.audience.join(', ')}`,
    p.location && `Market: ${p.location}`,
    seeds.length && `Seed keywords to build around: ${seeds.join(', ')}`,
    siteText && `\n## Website content (untrusted data)\n${sandbox('website_content', siteText)}`,
    instruction && `\n## User steering (untrusted data)\n${sandbox('user_instruction', instruction)}`,
    '',
    '## Task',
    `List exactly ${limit} distinct non-branded keywords${input.language && input.language !== 'English' ? ` in ${input.language}` : ''}. ` +
      'Mix core product/service terms, use-case terms, audience terms, problem terms and location-modified terms.',
    'Return JSON: {"keywords":[{"keyword": string, "type": "product" | "service" | "use-case" | "audience" | "problem" | "location"}]}',
  ].filter(Boolean).join('\n');

  try {
    const { data } = await callJson(llm, { system: SYSTEM, user, maxTokens: 2500 }, usage);
    const list = Array.isArray(data?.keywords) ? data.keywords : Array.isArray(data) ? data : [];
    const seen = new Set(seeds.map((s) => s.toLowerCase()));
    const out = seeds.map((keyword) => ({ keyword, type: 'seed' }));
    for (const item of list) {
      const keyword = (typeof item === 'string' ? item : item?.keyword || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 80);
      if (!keyword || seen.has(keyword) || isBrand(keyword)) continue;
      seen.add(keyword);
      out.push({ keyword, type: typeof item?.type === 'string' ? item.type : 'extracted' });
      if (out.length >= limit) break;
    }
    if (!out.length) {
      warnings.push('The model returned no usable keywords; used the heuristic extractor.');
      return fallback();
    }
    return { keywords: out, source: 'llm', warnings };
  } catch (err) {
    warnings.push(`Keyword model call failed: ${err.message}`);
    return fallback();
  }
}
