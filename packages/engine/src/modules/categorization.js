// Module: prompt categorization.
// Decides category (branded / non-branded), intent and sentiment for a prompt.
// Category is always decided here from the text, never trusted from a model.
// Intent and sentiment from a model are kept when valid, otherwise inferred.

import { INTENTS } from '../constants.js';
import { brandMatcher } from '../text.js';

const INTENT_RULES = [
  ['comparison', /\b(vs\.?|versus|compare[ds]?|comparison|alternatives?( to)?|better than|or .+ which|difference between .+ and)\b/i],
  ['local', /\b(near me|nearby|in my area|open now|closest|around me)\b/i],
  ['review', /\b(reviews?|ratings?|rated|worth it|reliable|trustworthy|legit|scam|experiences?|complaints?|opinions?|testimonials?|feedback)\b/i],
  ['transactional', /\b(buy|order|book|booking|hire|get a quote|quote|price of|pricing|cost of|how much|discount|coupon|deal|deliver(y|s)?|subscribe|sign up|purchase|cheapest)\b/i],
  ['navigational', /\b(official (site|website)|website|login|contact (details|number)|phone number|address of|customer care|app download)\b/i],
  ['commercial', /\b(best|top( \d+)?|recommended|recommend|leading|popular|most affordable|affordable|premium|which .+ should i)\b/i],
  ['informational', /\b(what|how|why|when|guide|tips|ideas|explain|meaning|should i know|is it safe|benefits)\b/i],
];

const NEGATIVE = /\b(complaints?|problems?|issues?|avoid|worst|scam|red flags?|risks?|downsides?|cons\b|bad|fail(s|ed|ure)?|refund|disappoint\w*|overpriced|warning|mistakes?)\b/i;
const POSITIVE = /\b(best[- ]loved|loved|love|highest[- ]rated|top[- ]rated|glowing|amazing|excellent|award[- ]winning|favou?rite|most trusted|recommended|happy customers|success stories)\b/i;

/** Infer an intent from wording. Returns the first allowed rule that matches. */
export function inferIntent(text, allowed = Object.keys(INTENTS)) {
  for (const [intent, re] of INTENT_RULES) {
    if (allowed.includes(intent) && re.test(text)) return intent;
  }
  return allowed.includes('commercial') ? 'commercial' : allowed[0];
}

export function inferSentiment(text) {
  if (NEGATIVE.test(text)) return 'negative';
  if (POSITIVE.test(text)) return 'positive';
  return 'neutral';
}

/**
 * Build a categorizer bound to one brand and one set of allowed intents.
 * @returns {(text:string, hints?:{intent?:string, sentiment?:string}) => {category, intent, intentSource, sentiment}}
 */
export function createCategorizer({ brand, intents } = {}) {
  const isBranded = brandMatcher(brand);
  const hasBrand = Boolean(brand?.name);
  const allowed = intents?.length ? intents : Object.keys(INTENTS);
  return (text, hints = {}) => {
    const modelIntent = typeof hints.intent === 'string' ? hints.intent.toLowerCase().trim() : null;
    const modelSentiment = typeof hints.sentiment === 'string' ? hints.sentiment.toLowerCase().trim() : null;
    const validIntent = modelIntent && allowed.includes(modelIntent);
    return {
      category: hasBrand && isBranded(text) ? 'Branded' : 'Non-branded',
      intent: validIntent ? modelIntent : inferIntent(text, allowed),
      intentSource: validIntent ? 'model' : 'rules',
      sentiment: ['positive', 'neutral', 'negative'].includes(modelSentiment) ? modelSentiment : inferSentiment(text),
    };
  };
}

/** Categorize a list of prompt objects ({ text, intent?, sentiment? }). */
export function categorizePrompts(prompts, { brand, intents } = {}) {
  const categorize = createCategorizer({ brand, intents });
  return prompts.map((p) => ({ ...p, ...categorize(p.text, p) }));
}
