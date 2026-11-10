// @promptgen/providers — LLM adapters behind one contract:
//   complete({ system, user, json?, maxTokens?, temperature?, signal? })
//     → { text, model, provider, latencyMs, usage: { inputTokens, outputTokens } }
//
// Adding a provider = adding an adapter object to ADAPTERS. The engine never
// changes.

import { makeComplete } from './base.js';
import { anthropic } from './adapters/anthropic.js';
import { gemini } from './adapters/gemini.js';
import { openai } from './adapters/openai.js';
import { custom, deepseek, groq, mistral, ollama, openrouter } from './adapters/openaiCompatible.js';

export { ProviderError, withRetry } from './base.js';

export const ADAPTERS = { openai, anthropic, gemini, groq, mistral, deepseek, openrouter, ollama, custom };
export const OFFLINE = 'offline';

/**
 * Build a registry from environment variables.
 * @param {{env?: Record<string,string|undefined>, fetchImpl?: Function, adapters?: object, retry?: object}} [opts]
 */
export function createProviderRegistry({ env = process.env, fetchImpl = globalThis.fetch, adapters = ADAPTERS, retry } = {}) {
  const configOf = (a) => ({
    apiKey: a.envApiKey === null ? undefined : env[a.envApiKey || a.envKey],
    baseUrl: a.envBaseUrl ? env[a.envBaseUrl] : undefined,
    model: env[a.envModel] || a.defaultModel,
  });
  // An adapter is configured when its key (or, for local/custom ones, its base URL) is set.
  const isConfigured = (a) => Boolean(env[a.envKey]);

  const list = () => Object.values(adapters).map((a) => ({
    id: a.id,
    label: a.label,
    configured: isConfigured(a),
    defaultModel: configOf(a).model,
    models: [...new Set([configOf(a).model, ...(a.models || [])])],
  }));

  const defaultId = () => {
    const wanted = (env.LLM_PROVIDER || '').toLowerCase().trim();
    if (wanted === OFFLINE) return OFFLINE;
    if (wanted && adapters[wanted] && isConfigured(adapters[wanted])) return wanted;
    return Object.values(adapters).find(isConfigured)?.id || OFFLINE;
  };

  /**
   * Get an llm for a provider id (default when omitted). Returns null for offline,
   * which puts the engine in template mode.
   */
  const get = (id, { model } = {}) => {
    const pid = (id || defaultId()).toLowerCase();
    if (pid === OFFLINE) return null;
    const a = adapters[pid];
    if (!a) throw Object.assign(new Error(`Unknown provider "${pid}". Available: ${Object.keys(adapters).join(', ')}, ${OFFLINE}`), { status: 400 });
    if (!isConfigured(a)) throw Object.assign(new Error(`Provider "${pid}" is not configured (set ${a.envKey}).`), { status: 400 });
    const cfg = configOf(a);
    const useModel = (model || cfg.model).trim();
    const send = a.send({ ...cfg, model: useModel, fetchImpl });
    return { id: a.id, model: useModel, complete: makeComplete({ id: a.id, model: useModel, send, retry }) };
  };

  return { list, defaultId, get };
}
