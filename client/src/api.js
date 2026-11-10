// Client for the engine's public API (/api/v1). The web UI uses exactly the
// same endpoints other applications do.
// Same-origin by default (Vercel serves the UI and /api from one project; Vite
// proxies /api in dev). Set VITE_API_BASE_URL only if the API lives on another domain.
const BASE = `${(import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')}/api/v1`;
const KEY = import.meta.env.VITE_ENGINE_API_KEY;

const headers = (contentType = 'application/json') => ({
  'content-type': contentType,
  'x-client': 'ui',
  ...(KEY ? { authorization: `Bearer ${KEY}` } : {}),
});

/** `body` is sent as JSON; `file` (a File/Blob) is sent as-is. */
async function request(path, { method = 'GET', body, file } = {}) {
  const init = file
    ? { method, headers: headers(file.type || 'application/octet-stream'), body: file }
    : { method, headers: headers(), body: body ? JSON.stringify(body) : undefined };
  const res = await fetch(`${BASE}${path}`, init);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.details = data.details;
    throw err;
  }
  return data;
}

export const api = {
  meta: () => request('/meta'),
  analyzeBrand: (body) => request('/brand/analyze', { method: 'POST', body }),
  extractKeywords: (body) => request('/keywords/extract', { method: 'POST', body }),
  importKeywords: (file) => request('/keywords/import', { method: 'POST', file }),
  startRun: (body) => request('/runs', { method: 'POST', body }),
  run: (id) => request(`/runs/${id}`),
  runs: () => request('/runs'),
  cancelRun: (id) => request(`/runs/${id}/cancel`, { method: 'POST' }),
  savePrompts: (id, prompts) => request(`/runs/${id}/prompts`, { method: 'PUT', body: { prompts } }),
  deleteRun: (id) => request(`/runs/${id}`, { method: 'DELETE' }),
  async exportFile(runId, prompts, format = 'xlsx') {
    const res = await fetch(`${BASE}/export`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ runId, prompts, onlySelected: true, format }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Export failed');
    }
    const blob = await res.blob();
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || `prompts.${format}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  },
};
