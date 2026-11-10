import { postJson } from '../base.js';

/** Anthropic Messages API (Claude). */
export const anthropic = {
  id: 'anthropic',
  label: 'Claude (Anthropic)',
  envKey: 'ANTHROPIC_API_KEY',
  envModel: 'ANTHROPIC_MODEL',
  defaultModel: 'claude-sonnet-5-5',
  models: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'],

  send({ apiKey, model, baseUrl, fetchImpl }) {
    const url = `${(baseUrl || 'https://api.anthropic.com/v1').replace(/\/$/, '')}/messages`;
    return async ({ system, user, json, maxTokens, temperature, signal }) => {
      const data = await postJson({
        provider: 'anthropic',
        url,
        fetchImpl,
        signal,
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: {
          model,
          max_tokens: maxTokens || 4096,
          system: json ? `${system}\nRespond with a single valid JSON value and nothing else.` : system,
          messages: [{ role: 'user', content: user }],
          ...(temperature !== undefined ? { temperature } : {}),
        },
      });
      const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      return { text, usage: { inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens } };
    };
  },
};
