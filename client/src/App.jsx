import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { customCount, splitList, storage, uniqueKeywords } from './utils.js';
import GeneratorForm from './components/GeneratorForm.jsx';
import ResultsTable from './components/ResultsTable.jsx';
import History from './components/History.jsx';

const DEFAULT_FORM = {
  provider: '', model: '',
  name: '', keywords: '', promptsPerKeyword: 5, promptCounts: {}, minQualityScore: 0,
  brandName: '', brandWebsite: '', brandIndustry: '', brandDescription: '', brandAliases: '', competitors: '',
  brandMode: 'non-branded', brandedRatio: 30, brandedSplit: 'ratio', brandedNumber: 0, analyzeWebsite: false,
  intents: [], sentiment: 'neutral', topic: '', location: '', languages: ['English'], instruction: '',
};

/** Saved form, upgraded from the single `language` field used before multi-language support. */
function loadForm() {
  const { language, ...saved } = storage.get('pg_form_v2', {});
  const languages = Array.isArray(saved.languages) && saved.languages.length ? saved.languages : [language || 'English'];
  const promptCounts = saved.promptCounts && typeof saved.promptCounts === 'object' && !Array.isArray(saved.promptCounts) ? saved.promptCounts : {};
  return { ...DEFAULT_FORM, ...saved, languages, promptCounts };
}

export default function App() {
  const [meta, setMeta] = useState(null);
  const [form, setForm] = useState(loadForm);
  const [runs, setRuns] = useState([]);
  const [run, setRun] = useState(null);
  const [prompts, setPrompts] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [progress, setProgress] = useState(null);
  const [activeRunId, setActiveRunId] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const pollRef = useRef(null);

  useEffect(() => { storage.set('pg_form_v2', form); }, [form]);

  const refreshRuns = useCallback(() => api.runs().then(setRuns).catch(() => {}), []);

  useEffect(() => {
    api.meta().then(setMeta).catch((err) => {
      if (err.message.includes('API key')) return setError(err.message);
      const local = ['localhost', '127.0.0.1'].includes(window.location.hostname);
      setError(local
        ? `Cannot reach the API (${err.message}). Is the server running on port 5000?`
        : `Cannot reach the API at /api/v1 (${err.message}). This deployment is serving the UI without the API: ` +
          'in Vercel, set the project Root Directory to the repository root (not "client") and redeploy.');
    });
    refreshRuns();
    return () => clearTimeout(pollRef.current);
  }, [refreshRuns]);

  const loadRun = useCallback((data) => {
    setRun(data);
    setPrompts(data.prompts || []);
    setDirty(false);
  }, []);

  const poll = useCallback((id) => {
    clearTimeout(pollRef.current);
    api.run(id).then((data) => {
      if (['queued', 'running', 'cancelling'].includes(data.status)) {
        setProgress({ ...(data.progress || {}), status: data.status });
        pollRef.current = setTimeout(() => poll(id), 800);
        return;
      }
      setBusy(false);
      setProgress(null);
      setActiveRunId(null);
      if (data.status === 'failed') setError(`Generation failed: ${data.error}`);
      if (data.warnings?.length) setError(data.warnings.join(' '));
      loadRun(data);
      refreshRuns();
    }).catch((err) => {
      setBusy(false);
      setError(err.message);
    });
  }, [loadRun, refreshRuns]);

  const generate = async (llmBody) => {
    setError('');
    setBusy(true);
    setRun(null);
    setPrompts([]);
    setProgress({ status: 'queued', log: [] });
    try {
      const keywords = uniqueKeywords(form.keywords);
      const { runId } = await api.startRun({
        ...llmBody,
        name: form.name,
        keywords,
        // Only keywords with their own count; the rest use promptsPerKeyword.
        promptsByKeyword: Object.fromEntries(keywords
          .filter((k) => customCount(form.promptCounts, k) !== undefined)
          .map((k) => [k, customCount(form.promptCounts, k)])),
        brand: {
          name: form.brandName, website: form.brandWebsite, aliases: splitList(form.brandAliases),
          competitors: splitList(form.competitors), industry: form.brandIndustry,
        },
        analyzeWebsite: form.analyzeWebsite && Boolean(form.brandWebsite.trim()),
        brandMode: form.brandMode,
        brandedRatio: Number(form.brandedRatio),
        intents: form.intents,
        sentiment: form.sentiment,
        topic: form.topic,
        location: form.location,
        languages: form.languages,
        context: form.brandDescription,
        instruction: form.instruction,
        promptsPerKeyword: Number(form.promptsPerKeyword),
        minQualityScore: Number(form.minQualityScore),
      });
      setActiveRunId(runId);
      refreshRuns();
      poll(runId);
    } catch (err) {
      setBusy(false);
      setProgress(null);
      setError(err.details ? `${err.message}: ${err.details.join('; ')}` : err.message);
    }
  };

  const cancel = () => activeRunId && api.cancelRun(activeRunId).catch((err) => setError(err.message));

  const openRun = async (id) => {
    if (busy) return;
    if (dirty && !window.confirm('Discard unsaved changes to the current run?')) return;
    setError('');
    try { loadRun(await api.run(id)); } catch (err) { setError(err.message); }
  };

  const removeRun = async (id) => {
    if (!window.confirm('Delete this run? This cannot be undone.')) return;
    await api.deleteRun(id).catch(() => {});
    if (run?.id === id) { setRun(null); setPrompts([]); }
    refreshRuns();
  };

  const updatePrompts = (updater) => { setPrompts(updater); setDirty(true); };

  const save = async () => {
    setSaving(true);
    try { await api.savePrompts(run.id, prompts); setDirty(false); } catch (err) { setError(err.message); }
    setSaving(false);
  };

  const exportFile = async (format) => {
    setExporting(true);
    try { await api.exportFile(run.id, prompts, format); } catch (err) { setError(err.message); }
    setExporting(false);
  };

  const pct = progress?.target ? Math.min(100, Math.round((progress.generated / progress.target) * 100)) : 0;
  const defaultProvider = meta?.providers?.find((p) => p.id === meta.defaultProvider);

  return (
    <div className="app">
      <header>
        <div>
          <h1>Prompt Generation Engine</h1>
          <p className="muted">Turn a brand profile and keywords into the questions real customers ask AI assistants. Export to Excel or use the API.</p>
        </div>
        {meta && (
          <div className="status">
            <span className={`dot ${defaultProvider ? 'ok' : 'warn'}`} />
            {defaultProvider ? `Default: ${defaultProvider.label}` : 'Offline templates (no API key)'}
            <span className="sep">|</span>{meta.providers.filter((p) => p.configured).length} provider(s)
            <span className="sep">|</span>{meta.store === 'mongodb' ? 'MongoDB' : 'In-memory store'}
            <span className="sep">|</span>engine v{meta.engineVersion}
          </div>
        )}
      </header>

      {meta?.serverless && meta.store === 'memory' && (
        <div className="alert" role="alert">
          The live server has no database (MONGODB_URI is not set), so runs can disappear between requests.
          Add MONGODB_URI in the Vercel project settings and redeploy.
        </div>
      )}
      {error && <div className="alert" role="alert">{error}<button type="button" className="icon" aria-label="Dismiss" onClick={() => setError('')}>✕</button></div>}

      <main>
        <aside>
          <GeneratorForm meta={meta} form={form} setForm={setForm} onSubmit={generate} busy={busy} onError={setError} />
          <History runs={runs} activeId={run?.id} onOpen={openRun} onDelete={removeRun} />
        </aside>

        <section className="content">
          {busy && progress && (
            <div className="card progress">
              <div className="results-head">
                <h2>{progress.status === 'queued' ? 'Queued…' : 'Engine working…'}</h2>
                <button type="button" onClick={cancel} disabled={!activeRunId}>Cancel</button>
              </div>
              <div className="bar"><div style={{ width: `${pct}%` }} /></div>
              <p className="muted">
                {progress.generated ?? 0} / {progress.target || '…'} prompts
                {progress.languages > 1 ? ` · ${progress.language} (${progress.languageIndex + 1}/${progress.languages})` : ''}
                {progress.total ? ` · ${progress.round ? `top-up round ${progress.round}, ` : ''}batch ${progress.done}/${progress.total}` : ''}
              </p>
              <ul className="log">{(progress.log || []).slice(-6).map((l, i) => <li key={i}>{l}</li>)}</ul>
            </div>
          )}

          {!busy && run && (
            <ResultsTable run={run} meta={meta} prompts={prompts} setPrompts={updatePrompts} onSave={save} onExport={exportFile}
              dirty={dirty} saving={saving} exporting={exporting} />
          )}

          {!busy && !run && (
            <div className="card empty-state">
              <h2>How the engine works</h2>
              <ol>
                <li><b>Brand analysis:</b> optionally reads the website for industry, offerings, audience and competitors.</li>
                <li><b>Keyword extraction:</b> suggests non-branded keywords, or bring your own (paste or import).</li>
                <li><b>Instructions:</b> your context and instruction steer the prompts but can't override the engine's rules.</li>
                <li><b>Recommendations:</b> the chosen AI provider writes prompts in batches; shortfalls are re-requested.</li>
                <li><b>Categorization:</b> each prompt is labelled branded or non-branded from its text, plus intent and sentiment.</li>
                <li><b>Quality scoring:</b> each prompt gets a 0–100 score with flags; set a minimum to reject weak prompts.</li>
              </ol>
              <p className="muted">Other apps can do all of this through the same API: <code>POST /api/v1/runs</code> or <code>/api/v1/prompts/generate</code>.</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
