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

/** Read keywords from a .txt or .csv file: first column of each line. */
export async function readKeywordFile(file) {
  const text = await file.text();
  const lines = text.split(/\r?\n/);
  const isCsv = /\.csv$/i.test(file.name);
  const out = lines
    .map((l) => (isCsv ? l.split(',')[0] : l))
    .map((s) => s.replace(/^"|"$/g, '').trim())
    .filter(Boolean);
  // Drop a header row like "keyword"
  if (out.length && /^keywords?$/i.test(out[0])) out.shift();
  return out;
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
