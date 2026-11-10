import { postJson } from '../base.js';

/** Google Gemini generateContent API. */
export const gemini = {
  id: 'gemini',
  label: 'Google Gemini',
  envKey: 'GEMINI_API_KEY',
  envModel: 'GEMINI_MODEL',
  defaultModel: 'gemini-2.5-flash',
  models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite'],

  send({ apiKey, model, baseUrl, fetchImpl }) {
    const root = (baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    const url = `${root}/models/${encodeURIComponent(model)}:generateContent`;
    return async ({ system, user, json, maxTokens, temperature, signal }) => {
      const data = await postJson({
        provider: 'gemini',
        url,
        fetchImpl,
        signal,
        headers: { 'x-goog-api-key': apiKey },
        body: {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: {
            ...(json ? { responseMimeType: 'application/json' } : {}),
            ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
            ...(temperature !== undefined ? { temperature } : {}),
          },
        },
      });
      const cand = data.candidates?.[0];
      const text = (cand?.content?.parts || []).map((p) => p.text || '').join('');
      return {
        text,
        usage: { inputTokens: data.usageMetadata?.promptTokenCount, outputTokens: data.usageMetadata?.candidatesTokenCount },
      };
    };
  },
};
