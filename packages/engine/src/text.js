// Small text utilities shared by every engine module.

/** Lowercase, strip punctuation, collapse whitespace — the dedupe key. */
export function promptKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export const STOPWORDS = new Set((
  'a an the and or but if of to in on at by for with from as is are was were be been being it its this that these those ' +
  'i me my we our you your he she they them their what which who whom how why when where can could should would will do does ' +
  'did not no so than too very just about into over under more most some any all each other such only own same also vs near me ' +
  'youd youre youll youve dont cant wont isnt arent im ive weve theyre lets thats whats theres heres'
).split(' '));

export function tokens(text) {
  return promptKey(text).split(' ').filter(Boolean);
}

export function contentTokens(text) {
  return tokens(text).filter((t) => !STOPWORDS.has(t) && t.length > 1);
}

/** Jaccard similarity of content tokens, 0..1. */
export function similarity(a, b) {
  const A = new Set(contentTokens(a));
  const B = new Set(contentTokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Hostname without www, or null. */
export function hostOf(website) {
  if (!website) return null;
  try {
    return new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** Matcher that says whether text mentions the brand (name, aliases, domain) as a whole word. */
export function brandMatcher(brand) {
  const terms = [brand?.name, ...(brand?.aliases || [])]
    .map((t) => (t || '').trim())
    .filter((t) => t.length >= 2);
  const host = hostOf(brand?.website);
  if (host) terms.push(host);
  if (!terms.length) return () => false;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${terms.map(escapeRegex).join('|')})(?=$|[^\\p{L}\\p{N}])`, 'iu');
  return (text) => re.test(String(text ?? ''));
}

/** Dedupe a list of strings case-insensitively, trimming and capping each. */
export function uniqueStrings(list, max = 120) {
  const seen = new Set();
  const out = [];
  for (const raw of list || []) {
    const s = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    const k = s.toLowerCase();
    if (s && !seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}
