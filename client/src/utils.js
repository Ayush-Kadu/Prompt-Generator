export const splitList = (text) =>
  String(text || '')
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

export function uniqueKeywords(text) {
  const seen = new Set();
  return splitList(text).filter((k) => {
    const key = k.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const promptKey = (t) =>
  String(t).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Same rule as the server: whole-word match on brand name / aliases / domain. */
export function brandMatcher(brand) {
  const terms = [brand?.name, ...splitList(brand?.aliases)].filter((t) => t && t.length >= 2);
  if (brand?.website) {
    try {
      const u = new URL(/^https?:\/\//i.test(brand.website) ? brand.website : `https://${brand.website}`);
      terms.push(u.hostname.replace(/^www\./, ''));
    } catch { /* ignore */ }
  }
  if (!terms.length) return () => false;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${terms.map(esc).join('|')})(?=$|[^\\p{L}\\p{N}])`, 'iu');
  return (t) => re.test(t);
}

/**
 * Read keywords from a .txt or .csv file: first column of each line. In a .csv, a whole
 * number in the second column is that keyword's prompt count ("custom cakes,10").
 * @returns {Promise<{keywords:string[], counts:[string, number][]}>}
 */
export async function readKeywordFile(file) {
  const text = await file.text();
  const isCsv = /\.csv$/i.test(file.name);
  const unquote = (s) => (s || '').replace(/^"|"$/g, '').trim();
  const rows = text.split(/\r?\n/)
    .map((l) => (isCsv ? l.split(',') : [l]))
    .map(([kw, count]) => ({ keyword: unquote(kw), count: Number(unquote(count)) }))
    .filter((r) => r.keyword);
  // Drop a header row like "keyword" or "keyword,prompts"
  if (rows.length && /^keywords?$/i.test(rows[0].keyword)) rows.shift();
  return {
    keywords: rows.map((r) => r.keyword),
    counts: rows.filter((r) => Number.isInteger(r.count) && r.count >= 1).map((r) => [r.keyword, r.count]),
  };
}

/** A keyword's own prompt count from a { lowercased keyword: count } map, or undefined. */
export function customCount(counts, keyword) {
  const k = String(keyword).toLowerCase();
  return counts && Object.hasOwn(counts, k) ? counts[k] : undefined;
}

export const storage = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch { /* ignore */ }
  },
};
