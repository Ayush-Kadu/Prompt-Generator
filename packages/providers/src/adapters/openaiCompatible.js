import { postJson } from '../base.js';

/**
 * Any API that speaks OpenAI Chat Completions. Presets cover the common ones;
 * "custom" points at anything else via CUSTOM_LLM_BASE_URL.
 */
function compatible({ id, label, envKey, envApiKey = envKey, envModel, envBaseUrl, baseUrl, defaultModel, models, jsonMode = true }) {
  return {
    id, label, envKey, envApiKey, envModel, envBaseUrl, defaultModel, models,
    send({ apiKey, model, baseUrl: override, fetchImpl }) {
      const root = (override || baseUrl || '').replace(/\/$/, '');
      if (!root) throw new Error(`${id}: base URL is not configured`);
      return async ({ system, user, json, maxTokens, temperature, signal }) => {
        const data = await postJson({
          provider: id,
          url: `${root}/chat/completions`,
          fetchImpl,
          signal,
          headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
          body: {
            model,
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
            ...(maxTokens ? { max_tokens: maxTokens } : {}),
            ...(temperature !== undefined ? { temperature } : {}),
            ...(json && jsonMode ? { response_format: { type: 'json_object' } } : {}),
          },
        });
        return {
          text: data.choices?.[0]?.message?.content || '',
          usage: { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens },
        };
      };
    },
  };
}

export const groq = compatible({
  id: 'groq', label: 'Groq', envKey: 'GROQ_API_KEY', envModel: 'GROQ_MODEL',
  baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile', models: ['llama-3.3-70b-versatile'],
});

export const mistral = compatible({
  id: 'mistral', label: 'Mistral', envKey: 'MISTRAL_API_KEY', envModel: 'MISTRAL_MODEL',
  baseUrl: 'https://api.mistral.ai/v1', defaultModel: 'mistral-large-latest', models: ['mistral-large-latest', 'mistral-small-latest'],
});

export const deepseek = compatible({
  id: 'deepseek', label: 'DeepSeek', envKey: 'DEEPSEEK_API_KEY', envModel: 'DEEPSEEK_MODEL',
  baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat', models: ['deepseek-chat'],
});

export const openrouter = compatible({
  id: 'openrouter', label: 'OpenRouter', envKey: 'OPENROUTER_API_KEY', envModel: 'OPENROUTER_MODEL',
  baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openai/gpt-4.1-mini', models: ['openai/gpt-4.1-mini', 'anthropic/claude-sonnet-5-5', 'google/gemini-2.5-flash'],
});

export const ollama = compatible({
  id: 'ollama', label: 'Ollama (local)', envKey: 'OLLAMA_BASE_URL', envApiKey: null, envModel: 'OLLAMA_MODEL', envBaseUrl: 'OLLAMA_BASE_URL',
  baseUrl: 'http://localhost:11434/v1', defaultModel: 'llama3.1', models: ['llama3.1', 'qwen2.5'],
});

export const custom = compatible({
  id: 'custom', label: 'Custom (OpenAI-compatible)', envKey: 'CUSTOM_LLM_BASE_URL', envApiKey: 'CUSTOM_LLM_API_KEY', envModel: 'CUSTOM_LLM_MODEL', envBaseUrl: 'CUSTOM_LLM_BASE_URL',
  defaultModel: 'default', models: [],
});
