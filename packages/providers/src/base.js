// Shared plumbing for provider adapters: HTTP, errors, retries.

export class ProviderError extends Error {
  constructor(message, { provider, status, retryable = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
    this.retryable = retryable;
    // Bad credentials / model / quota-type errors will not fix themselves: stop the run.
    this.fatal = status === 401 || status === 403 || status === 404;
  }
}

export async function postJson({ provider, url, headers = {}, body, fetchImpl = globalThis.fetch, timeoutMs = 120000, signal }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => ctrl.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
      throw new ProviderError(`${provider}: network error (${err.cause?.code || err.message})`, { provider, retryable: true });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || data?.message || (typeof data?.error === 'string' ? data.error : null) || `HTTP ${res.status}`;
      throw new ProviderError(`${provider}: ${msg}`, { provider, status: res.status, retryable: res.status === 429 || res.status >= 500 });
    }
    return data;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry retryable ProviderErrors with exponential backoff + jitter. */
export async function withRetry(fn, { retries = 2, baseMs = 800, sleepFn = sleep } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!err?.retryable || attempt >= retries) throw err;
      await sleepFn(baseMs * 2 ** attempt + Math.random() * 250);
    }
  }
}

/**
 * Wrap a raw `send(req) → { text, usage }` into the engine's llm contract:
 * adds timing, provider/model labels and retries.
 */
export function makeComplete({ id, model, send, retry }) {
  return async (req) => {
    const started = Date.now();
    const { text, usage } = await withRetry(() => send(req), retry);
    return { text: text ?? '', model, provider: id, latencyMs: Date.now() - started, usage: usage || {} };
  };
}
