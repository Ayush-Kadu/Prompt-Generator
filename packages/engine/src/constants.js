export const INTENTS = {
  informational: 'Learning / how-to / what-is questions',
  commercial: '"Best X", top picks, buying research',
  transactional: 'Ready to buy, book, order, get a quote',
  comparison: 'X vs Y, alternatives, which is better',
  local: 'Near me / location-specific',
  review: 'Reviews, ratings, experiences, is it worth it',
  navigational: 'Looking for a specific site, page or provider',
};

export const SENTIMENTS = {
  neutral: 'Plain, objective questions',
  positive: 'Looking for the most loved, highest rated, success stories',
  negative: 'Problems, complaints, risks, what to avoid',
  mixed: 'A balanced mix of positive, neutral and negative',
};

export const BRAND_MODES = ['non-branded', 'branded', 'mixed'];

export const LANGUAGES = [
  'English', 'Hindi', 'Marathi', 'Bengali', 'Gujarati',
  'Spanish', 'French', 'German', 'Portuguese', 'Italian', 'Dutch',
  'Japanese', 'Arabic', 'Chinese (Simplified)',
];

export const LIMITS = {
  maxKeywords: 2000,
  maxPerKeyword: 25,
  maxTotalPrompts: 10000,
  maxInstruction: 500,
  maxContext: 1500,
  maxExtractKeywords: 200,
};
