// Deterministic template generator used by the recommendations module when no
// llm is configured. Lets the engine run end-to-end offline (tests, demos, CI).

const NON_BRANDED = {
  informational: [
    'what should I know before choosing {kw}', 'how do I pick the right {kw} for {aud}', 'what are the key features to look for in {kw}',
    'is {kw} worth it in {year}', 'how much should I expect to pay for {kw} {loc}', 'what questions should I ask before buying {kw}',
  ],
  commercial: [
    'best {kw} {loc}', 'top rated {kw} providers {loc}', 'which {kw} do experts recommend for {aud}', 'most affordable {kw} {loc}',
    'best {kw} for {aud}', 'top 10 {kw} options this year',
  ],
  transactional: [
    'where can I buy {kw} {loc}', 'get a quote for {kw} {loc}', 'book {kw} online {loc}', 'order {kw} with fast delivery {loc}',
    'cheapest place to get {kw} {loc}',
  ],
  comparison: [
    '{kw} alternatives worth considering', 'compare the leading {kw} providers {loc}', 'is {comp} the best option for {kw}',
    'which is better for {aud}: premium or budget {kw}', 'pros and cons of popular {kw} options',
  ],
  local: ['{kw} near me', 'best {kw} {loc} open now', 'trusted {kw} {loc} with good reviews', 'local {kw} {loc} recommendations'],
  review: ['{kw} reviews from real customers', 'which {kw} brands are the most reliable', 'honest opinions on {kw} {loc}', 'what do people say about {kw} providers'],
  navigational: ['official websites of the main {kw} providers {loc}', 'where to find a list of {kw} providers', 'contact details for {kw} companies {loc}'],
};

const BRANDED = [
  'is {brand} good for {kw}', '{brand} {kw} reviews', 'how does {brand} compare with other {kw} providers', 'how much does {brand} charge for {kw}',
  'is {brand} a trustworthy option for {kw} {loc}', 'alternatives to {brand} for {kw}', 'what do customers say about {brand} {kw}',
  '{brand} {kw} pricing and plans', 'does {brand} offer {kw} {loc}', 'pros and cons of {brand} for {kw}',
];

const SENTIMENT_WRAP = {
  positive: ['{p} — which ones do customers love most?', '{p}, only the highest rated please', '{p} with glowing reviews'],
  negative: ['{p} — what complaints should I watch out for?', '{p}, and what are the common problems?', '{p} — any red flags to avoid?'],
  neutral: ['{p}'],
};

const DEFAULT_AUDIENCES = ['small businesses', 'beginners', 'families', 'first-time buyers', 'busy professionals', 'students'];

const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '').replace(/\s+/g, ' ').replace(/\s([,?])/g, '$1').trim();

/** Returns the same JSON shape a model would: { prompts: [{ keyword, prompt, intent, sentiment }] } */
export function offlineGenerate(settings, batch) {
  const intents = settings.intents.length ? settings.intents : Object.keys(NON_BRANDED);
  const sentiments = settings.sentiment === 'mixed' ? ['neutral', 'positive', 'negative'] : [settings.sentiment || 'neutral'];
  const avoid = new Set(Object.values(batch.avoid || {}).flat().map((s) => s.toLowerCase()));
  const audiences = settings.profile?.audience?.length ? settings.profile.audience : DEFAULT_AUDIENCES;
  const loc = settings.location ? `in ${settings.location}` : '';
  const comp = settings.brand.competitors?.[0] || 'a premium brand';
  const seed = avoid.size;
  const prompts = [];

  for (const kw of batch.keywords) {
    // `forced`: write every prompt with this sentiment (exact sentiment numbers); otherwise cycle through them.
    const make = (count, branded, forced) => {
      let made = 0;
      for (let i = 0; made < count && i < count * 15; i++) {
        const n = i + seed;
        const intent = intents[n % intents.length];
        const sentiment = forced || sentiments[n % sentiments.length];
        const pool = branded ? BRANDED : NON_BRANDED[intent] || NON_BRANDED.commercial;
        const pick = branded ? n % pool.length : Math.floor(n / intents.length) % pool.length;
        const base = fill(pool[pick], {
          kw, loc, comp, brand: settings.brand.name, aud: audiences[n % audiences.length], year: new Date().getFullYear(),
        });
        const wraps = SENTIMENT_WRAP[sentiment];
        const prompt = fill(wraps[Math.floor(n / pool.length) % wraps.length], { p: base });
        if (avoid.has(prompt.toLowerCase())) continue;
        avoid.add(prompt.toLowerCase());
        prompts.push({ keyword: kw, prompt, intent: branded ? undefined : intent, sentiment });
        made++;
      }
    };
    if (batch.cells) {
      for (const s of ['positive', 'neutral', 'negative']) {
        make(batch.cells.nonBranded[s], false, s);
        make(batch.cells.branded[s], true, s);
      }
    } else {
      make(batch.nonBranded, false);
      make(batch.branded, true);
    }
  }
  return { prompts };
}
