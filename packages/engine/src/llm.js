// The engine's only contract with language models. The engine never imports a
// provider: callers inject a function (or an object with .complete) matching:
//
//   llm({ system, user, json?, maxTokens?, temperature?, signal? })
//     → Promise<{ text, model?, provider?, latencyMs?, usage?: { inputTokens?, outputTokens? } }>
//
// Passing no llm puts the engine in offline mode: every module has a
// deterministic heuristic path, so the engine always returns something useful.

export function toLlmFn(llm) {
  if (!llm) return null;
  if (typeof llm === 'function') return llm;
  if (typeof llm.complete === 'function') return (req) => llm.complete(req);
  throw new TypeError('llm must be a function or an object with a complete() method');
}

/** Pull a JSON value out of a model reply. Tolerates code fences and prose. Never throws. */
export function parseJsonReply(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(body);
  } catch { /* fall through */ }
  const first = Math.min(...['{', '['].map((c) => body.indexOf(c)).filter((i) => i >= 0));
  const last = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  if (!Number.isFinite(first) || last <= first) return null;
  body = body.slice(first, last + 1);
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** Tracks calls, latency and token usage across one engine operation. */
export class Usage {
  constructor() {
    this.calls = 0;
    this.failedCalls = 0;
    this.latencyMs = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.model = null;
    this.provider = null;
  }

  record(reply) {
    this.calls++;
    this.latencyMs += reply?.latencyMs || 0;
    this.inputTokens += reply?.usage?.inputTokens || 0;
    this.outputTokens += reply?.usage?.outputTokens || 0;
    this.model = reply?.model || this.model;
    this.provider = reply?.provider || this.provider;
  }

  toJSON() {
    return { ...this };
  }
}

/** Call the llm and parse JSON. Returns { data, reply } or throws the provider error. */
export async function callJson(llm, req, usage) {
  const reply = await llm({ json: true, ...req });
  usage?.record(reply);
  return { data: parseJsonReply(reply?.text), reply };
}
