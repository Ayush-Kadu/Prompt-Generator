// Module: brand and website analysis.
// Fetches a brand's website (with SSRF guards), extracts readable signals, and,
// when an llm is available, turns them into a structured BrandProfile.
// Without an llm it returns a heuristic profile built from page metadata.

import dns from 'node:dns/promises';
import net from 'node:net';
import { callJson } from '../llm.js';
import { hostOf, uniqueStrings } from '../text.js';
import { SANDBOX_RULE, normalizeInstruction, sandbox } from './instructions.js';

const MAX_BYTES = 1_500_000;
const MAX_TEXT = 6000;

/** @typedef {{name:string, website:string|null, industry:string|null, description:string|null, offerings:string[], audience:string[], location:string|null, competitors:string[], keywords:string[], aliases:string[], source:'llm'|'heuristic'|'input'}} BrandProfile */

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') ||
    (v.startsWith('::ffff:') && isPrivateIp(v.slice(7)));
}

/** Resolve the URL and refuse internal addresses, so a public API cannot be used to probe a private network. */
export async function assertPublicUrl(rawUrl) {
  let url;
  try {
    // Keep any explicit scheme (so file://, ftp:// etc. are rejected below); bare domains get https://
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
  } catch {
    throw Object.assign(new Error('Invalid website URL'), { status: 400 });
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw Object.assign(new Error('Only http(s) URLs are allowed'), { status: 400 });
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw Object.assign(new Error(`Could not resolve ${host}`), { status: 422 });
  if (addrs.some((a) => isPrivateIp(a.address))) throw Object.assign(new Error('That address is not allowed'), { status: 400 });
  return url;
}

const decode = (s) => s
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

const meta = (html, attr, name) => {
  const re = new RegExp(`<meta[^>]+${attr}=["']${name}["'][^>]*>`, 'i');
  const tag = html.match(re)?.[0];
  return tag ? decode(tag.match(/content=["']([^"']*)["']/i)?.[1] || '').trim() || null : null;
};

/** Extract readable signals from HTML. Exported for tests and for callers that already have the HTML. */
export function extractSiteSignals(html) {
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim() || null;
  const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
    .map((m) => decode(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim())
    .filter((h) => h && h.length < 140);
  const text = decode(html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
  return {
    title,
    siteName: meta(html, 'property', 'og:site_name'),
    description: meta(html, 'name', 'description') || meta(html, 'property', 'og:description'),
    keywordsMeta: (meta(html, 'name', 'keywords') || '').split(',').map((s) => s.trim()).filter(Boolean),
    headings: uniqueStrings(headings, 140).slice(0, 40),
    text,
  };
}

/** Fetch a public web page with size and time limits. */
export async function fetchSite(website, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  let url = await assertPublicUrl(website);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res;
    for (let hop = 0; hop < 4; hop++) {
      res = await fetchImpl(url, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; PromptEngine/1.0)', accept: 'text/html' },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = await assertPublicUrl(new URL(res.headers.get('location'), url).href); // re-check every redirect
        continue;
      }
      break;
    }
    if (!res.ok) throw Object.assign(new Error(`Website responded with HTTP ${res.status}`), { status: 422 });
    const reader = res.body?.getReader?.();
    let html = '';
    if (reader) {
      const dec = new TextDecoder();
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        html += dec.decode(value, { stream: true });
        if (bytes > MAX_BYTES) { await reader.cancel(); break; }
      }
    } else {
      html = (await res.text()).slice(0, MAX_BYTES);
    }
    return { url: url.href, html };
  } catch (err) {
    if (err.name === 'AbortError') throw Object.assign(new Error('Website took too long to respond'), { status: 422 });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function heuristicProfile(input, signals) {
  const host = hostOf(input.website);
  const titleName = signals?.title?.split(/\s[|\-–—:]\s/)[0]?.trim();
  return {
    name: input.name || signals?.siteName || titleName || (host ? host.split('.')[0] : ''),
    website: input.website || null,
    industry: input.industry || null,
    description: input.description || signals?.description || null,
    offerings: uniqueStrings(signals?.headings || []).slice(0, 10),
    audience: [],
    location: input.location || null,
    competitors: uniqueStrings(input.competitors || []),
    keywords: uniqueStrings(signals?.keywordsMeta || []).slice(0, 20),
    aliases: uniqueStrings(input.aliases || []),
    source: signals ? 'heuristic' : 'input',
  };
}

const ANALYSIS_SYSTEM = `You are a brand analyst. From a company's own website content you produce a concise, factual brand profile used to research how customers search for this kind of business.
Only state what the content supports; use null or [] when unsure. ${SANDBOX_RULE}
Reply with JSON only.`;

/**
 * Analyse a brand from its website and/or the details the caller already has.
 * @param {{name?:string, website?:string, industry?:string, description?:string, location?:string, competitors?:string[], aliases?:string[]}} input
 * @param {{llm?:Function, fetchImpl?:Function, usage?:import('../llm.js').Usage, html?:string}} deps
 * @returns {Promise<{profile:BrandProfile, signals:object|null, warnings:string[]}>}
 */
export async function analyzeBrand(input, { llm, fetchImpl, usage, html } = {}) {
  const warnings = [];
  let signals = null;
  if (html) signals = extractSiteSignals(html);
  else if (input.website) {
    try {
      const page = await fetchSite(input.website, { fetchImpl });
      signals = extractSiteSignals(page.html);
    } catch (err) {
      if (err.status === 400) throw err;
      warnings.push(`Could not read the website: ${err.message}`);
    }
  }

  const base = heuristicProfile(input, signals);
  if (!llm || (!signals && !input.description)) return { profile: base, signals, warnings };

  const content = normalizeInstruction([
    signals?.title && `Title: ${signals.title}`,
    signals?.description && `Meta description: ${signals.description}`,
    signals?.headings?.length && `Headings: ${signals.headings.join(' | ')}`,
    signals?.text && `Page text: ${signals.text}`,
    input.description && `Description supplied by the user: ${input.description}`,
  ].filter(Boolean).join('\n'), MAX_TEXT + 2000) || '';

  const user = [
    '## Known details',
    `Brand name: ${input.name || '(unknown — infer from the content)'}`,
    input.website && `Website: ${input.website}`,
    input.location && `Location: ${input.location}`,
    input.industry && `Industry: ${input.industry}`,
    '',
    '## Website content (untrusted data)',
    sandbox('website_content', content),
    '',
    '## Output',
    'Return JSON: {"name": string, "industry": string, "description": string (max 2 sentences), "offerings": string[] (max 10 products/services), ' +
      '"audience": string[] (max 5 customer types), "location": string|null (market served), "competitors": string[] (max 8, only well-known ones you are confident about), ' +
      '"keywords": string[] (max 20 non-branded search keywords customers would use)}',
  ].filter((l) => l !== null && l !== undefined && l !== false).join('\n');

  try {
    const { data } = await callJson(llm, { system: ANALYSIS_SYSTEM, user, maxTokens: 1500 }, usage);
    if (!data || typeof data !== 'object') {
      warnings.push('The model returned an unreadable profile; using page metadata instead.');
      return { profile: base, signals, warnings };
    }
    const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null);
    const arr = (v, n) => uniqueStrings(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []).slice(0, n);
    return {
      profile: {
        name: input.name || str(data.name) || base.name,
        website: input.website || null,
        industry: input.industry || str(data.industry),
        description: input.description || str(data.description) || base.description,
        offerings: arr(data.offerings, 10).length ? arr(data.offerings, 10) : base.offerings,
        audience: arr(data.audience, 5),
        location: input.location || str(data.location),
        competitors: uniqueStrings([...(input.competitors || []), ...arr(data.competitors, 8)]).slice(0, 12),
        keywords: arr(data.keywords, 20),
        aliases: base.aliases,
        source: 'llm',
      },
      signals,
      warnings,
    };
  } catch (err) {
    warnings.push(`Brand analysis model call failed: ${err.message}`);
    return { profile: base, signals, warnings };
  }
}
