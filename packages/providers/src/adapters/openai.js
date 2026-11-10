import { postJson } from '../base.js';

/** OpenAI Responses API. */
export const openai = {
  id: 'openai',
  label: 'OpenAI',
  envKey: 'OPENAI_API_KEY',
  envModel: 'OPENAI_MODEL',
  defaultModel: 'gpt-4.1-mini',
  models: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'gpt-4o'],

  send({ apiKey, model, baseUrl, fetchImpl }) {
    const url = `${(baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')}/responses`;
    return async ({ system, user, json, maxTokens, temperature, signal }) => {
      const data = await postJson({
        provider: 'openai',
        url,
        fetchImpl,
        signal,
        headers: { authorization: `Bearer ${apiKey}` },
        body: {
          model,
          instructions: system,
          input: user,
          ...(maxTokens ? { max_output_tokens: maxTokens } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
          ...(json ? { text: { format: { type: 'json_object' } } } : {}),
        },
      });
      const text = typeof data.output_text === 'string'
        ? data.output_text
        : (data.output || []).flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
      return { text, usage: { inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens } };
    };
  },
};
