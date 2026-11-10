import { useRef, useState } from 'react';
import { api } from '../api.js';
import { readKeywordFile, splitList, uniqueKeywords } from '../utils.js';

const FALLBACK_LANGUAGES = ['English', 'Hindi', 'Marathi', 'Bengali', 'Gujarati'];

function Segmented({ value, options, onChange }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map(([v, label]) => (
        <button type="button" key={v} role="radio" aria-checked={value === v}
          className={value === v ? 'active' : ''} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export default function GeneratorForm({ meta, form, setForm, onSubmit, busy, onError }) {
  const fileRef = useRef(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [profile, setProfile] = useState(null);
  const [suggested, setSuggested] = useState([]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const keywords = uniqueKeywords(form.keywords);
  const total = keywords.length * (Number(form.promptsPerKeyword) || 0);
  const limits = meta?.limits || { maxKeywords: 2000, maxPerKeyword: 25, maxTotalPrompts: 10000, maxInstruction: 500, maxContext: 1500 };
  const needsBrand = form.brandMode !== 'non-branded';
  const tooMany = total > limits.maxTotalPrompts || keywords.length > limits.maxKeywords;
  const brandedCount = form.brandMode === 'branded' ? form.promptsPerKeyword
    : form.brandMode === 'mixed' ? Math.round((form.promptsPerKeyword * form.brandedRatio) / 100) : 0;

  const providers = [...(meta?.providers || []).filter((p) => p.configured), { id: 'offline', label: 'Offline templates', models: ['templates'] }];
  const providerId = form.provider || meta?.defaultProvider || 'offline';
  const provider = providers.find((p) => p.id === providerId) || providers[providers.length - 1];
  const llmBody = { provider: provider.id, model: provider.id === 'offline' ? undefined : form.model || undefined };

  const brandBody = () => ({
    name: form.brandName, website: form.brandWebsite, aliases: splitList(form.brandAliases),
    competitors: splitList(form.competitors), industry: form.brandIndustry, description: form.brandDescription, location: form.location,
  });

  const analyze = async () => {
    setAnalyzing(true);
    try {
      const { profile: p, warnings } = await api.analyzeBrand({ ...brandBody(), ...llmBody });
      setProfile(p);
      setSuggested(p.keywords || []);
      setForm((f) => ({
        ...f,
        brandName: f.brandName || p.name || '',
        brandIndustry: f.brandIndustry || p.industry || '',
        brandDescription: f.brandDescription || p.description || '',
        competitors: [...new Set([...splitList(f.competitors), ...(p.competitors || [])])].join(', '),
        location: f.location || p.location || '',
      }));
      if (warnings?.length) onError(warnings.join(' '));
    } catch (err) {
      onError(err.details ? `${err.message}: ${err.details.join('; ')}` : err.message);
    }
    setAnalyzing(false);
  };

  const extract = async () => {
    setExtracting(true);
    try {
      const r = await api.extractKeywords({
        brand: brandBody(), analyzeWebsite: Boolean(form.brandWebsite), seedKeywords: keywords.slice(0, 50),
        limit: 30, instruction: form.instruction, language: form.language, ...llmBody,
      });
      const existing = new Set(keywords.map((k) => k.toLowerCase()));
      setSuggested(r.keywords.map((k) => k.keyword).filter((k) => !existing.has(k.toLowerCase())));
      if (r.warnings?.length) onError(r.warnings.join(' '));
    } catch (err) {
      onError(err.details ? `${err.message}: ${err.details.join('; ')}` : err.message);
    }
    setExtracting(false);
  };

  const addKeywords = (list) => {
    set({ keywords: [form.keywords.trim(), ...list].filter(Boolean).join('\n') });
    setSuggested((s) => s.filter((k) => !list.includes(k)));
  };

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    addKeywords(await readKeywordFile(file));
    e.target.value = '';
  };

  const toggleIntent = (i) =>
    set({ intents: form.intents.includes(i) ? form.intents.filter((x) => x !== i) : [...form.intents, i] });

  const submit = (e) => {
    e.preventDefault();
    if (!busy && keywords.length && !tooMany && (!needsBrand || form.brandName.trim())) onSubmit(llmBody);
  };

  return (
    <form className="card form" onSubmit={submit}>
      <h2>Generate prompts</h2>

      <section>
        <div className="grid2">
          <label className="field">
            <span>AI provider</span>
            <select value={provider.id} onChange={(e) => set({ provider: e.target.value, model: '' })}>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Model</span>
            <input list="models" value={provider.id === 'offline' ? 'templates' : form.model} disabled={provider.id === 'offline'}
              placeholder={provider.defaultModel} onChange={(e) => set({ model: e.target.value })} />
            <datalist id="models">{(provider.models || []).map((m) => <option key={m} value={m} />)}</datalist>
          </label>
        </div>
        {provider.id === 'offline' && (
          <small>No AI provider is configured, so the engine uses built-in templates. Add an API key in <code>server/.env</code>.</small>
        )}
      </section>

      <section>
        <h3>Brand</h3>
        <div className="grid2">
          <label className="field">
            <span>Brand name {needsBrand ? '' : <em>optional</em>}</span>
            <input value={form.brandName} placeholder="Sweet Crumbs" onChange={(e) => set({ brandName: e.target.value })} />
          </label>
          <label className="field">
            <span>Website <em>optional</em></span>
            <input value={form.brandWebsite} placeholder="sweetcrumbs.in" onChange={(e) => set({ brandWebsite: e.target.value })} />
          </label>
          <label className="field">
            <span>Industry <em>optional</em></span>
            <input value={form.brandIndustry} maxLength={200} placeholder="Bakery" onChange={(e) => set({ brandIndustry: e.target.value })} />
          </label>
          <label className="field">
            <span>Aliases <em>comma separated</em></span>
            <input value={form.brandAliases} placeholder="SweetCrumbs, SC Bakery" onChange={(e) => set({ brandAliases: e.target.value })} />
          </label>
        </div>
        <label className="field">
          <span>Competitors <em>comma separated</em></span>
          <input value={form.competitors} placeholder="Bakingo, FNP" onChange={(e) => set({ competitors: e.target.value })} />
        </label>
        <div className="row-buttons">
          <button type="button" onClick={analyze} disabled={analyzing || (!form.brandWebsite.trim() && !form.brandDescription.trim())}>
            {analyzing ? 'Analysing…' : 'Analyse website'}
          </button>
          <small>Reads the site to fill in industry, offerings, audience and competitors.</small>
        </div>
        {profile && (
          <div className="profile">
            {profile.offerings?.length > 0 && <p><b>Offers:</b> {profile.offerings.join(', ')}</p>}
            {profile.audience?.length > 0 && <p><b>Audience:</b> {profile.audience.join(', ')}</p>}
            <small>Source: {profile.source === 'llm' ? 'AI analysis' : 'page metadata'}</small>
          </div>
        )}

        <div className="field">
          <span>Branded vs non-branded</span>
          <Segmented value={form.brandMode} onChange={(v) => set({ brandMode: v })}
            options={[['non-branded', 'Non-branded'], ['branded', 'Branded'], ['mixed', 'Mixed']]} />
          {form.brandMode === 'mixed' && (
            <div className="ratio">
              <input type="range" min={0} max={100} step={5} value={form.brandedRatio} aria-label="Branded share"
                onChange={(e) => set({ brandedRatio: Number(e.target.value) })} />
              <small>{form.brandedRatio}% branded → {brandedCount} branded + {form.promptsPerKeyword - brandedCount} non-branded per keyword</small>
            </div>
          )}
          {needsBrand && !form.brandName.trim() && <small className="error">Add a brand name for branded or mixed prompts.</small>}
          {form.brandMode === 'non-branded' && <small>Non-branded prompts never mention the brand: they measure unprompted visibility.</small>}
        </div>
      </section>

      <section>
        <div className="field">
          <div className="field-head">
            <span>Keywords</span>
            <span className="links">
              <button type="button" className="link" onClick={extract} disabled={extracting || (!form.brandWebsite && !form.brandIndustry && !keywords.length)}>
                {extracting ? 'Suggesting…' : 'Suggest keywords'}
              </button>
              <button type="button" className="link" onClick={() => fileRef.current?.click()}>Import .txt / .csv</button>
            </span>
            <input ref={fileRef} type="file" accept=".txt,.csv" hidden onChange={onFile} />
          </div>
          <textarea rows={6} value={form.keywords} placeholder={'One per line or comma separated\ncustom cakes\nbirthday cakes\neggless cakes'}
            onChange={(e) => set({ keywords: e.target.value })} />
          {suggested.length > 0 && (
            <div className="suggest">
              <div className="field-head">
                <small>Suggested keywords — click to add</small>
                <button type="button" className="link" onClick={() => addKeywords(suggested)}>Add all {suggested.length}</button>
              </div>
              <div className="chips">
                {suggested.map((k) => <button type="button" key={k} className="chip" onClick={() => addKeywords([k])}>+ {k}</button>)}
              </div>
            </div>
          )}
          <small className={tooMany ? 'error' : ''}>
            {keywords.length} unique keyword{keywords.length === 1 ? '' : 's'} × {form.promptsPerKeyword} = <b>{total}</b> prompts
            {tooMany && ` — over the limit of ${limits.maxTotalPrompts} prompts / ${limits.maxKeywords} keywords`}
          </small>
        </div>

        <div className="grid2">
          <label className="field">
            <span>Prompts per keyword</span>
            <input type="number" min={1} max={limits.maxPerKeyword} value={form.promptsPerKeyword}
              onChange={(e) => set({ promptsPerKeyword: Math.max(1, Math.min(limits.maxPerKeyword, Number(e.target.value) || 1)) })} />
          </label>
          <label className="field">
            <span>Min quality score <em>{form.minQualityScore ? `${form.minQualityScore}+` : 'keep all'}</em></span>
            <input type="range" min={0} max={90} step={5} value={form.minQualityScore}
              onChange={(e) => set({ minQualityScore: Number(e.target.value) })} />
          </label>
        </div>
      </section>

      <section>
        <h3>Shape the prompts</h3>
        <div className="field">
          <span>Intent <em>{form.intents.length ? `${form.intents.length} selected` : 'none selected = all'}</em></span>
          <div className="chips">
            {Object.entries(meta?.intents || {}).map(([k, desc]) => (
              <button type="button" key={k} title={desc} aria-pressed={form.intents.includes(k)}
                className={form.intents.includes(k) ? 'chip on' : 'chip'} onClick={() => toggleIntent(k)}>
                {k}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span>Sentiment</span>
          <Segmented value={form.sentiment} onChange={(v) => set({ sentiment: v })}
            options={Object.keys(meta?.sentiments || { neutral: 1 }).map((s) => [s, s[0].toUpperCase() + s.slice(1)])} />
          <small>{meta?.sentiments?.[form.sentiment]}</small>
        </div>

        <div className="grid2">
          <label className="field">
            <span>Topic <em>optional</em></span>
            <input value={form.topic} maxLength={200} placeholder="Wedding & celebration cakes" onChange={(e) => set({ topic: e.target.value })} />
          </label>
          <label className="field">
            <span>Location <em>optional</em></span>
            <input value={form.location} maxLength={100} placeholder="Gurgaon, India" onChange={(e) => set({ location: e.target.value })} />
          </label>
          <label className="field">
            <span>Language</span>
            <select value={form.language} onChange={(e) => set({ language: e.target.value })}>
              {(meta?.languages || FALLBACK_LANGUAGES).map((l) => <option key={l}>{l}</option>)}
            </select>
          </label>
        </div>

        <label className="field">
          <span>Context <em>who the customers are, what the business does</em></span>
          <textarea rows={3} maxLength={limits.maxContext} value={form.brandDescription}
            placeholder="Premium home bakery delivering across NCR; customers are mostly parents planning kids' parties."
            onChange={(e) => set({ brandDescription: e.target.value })} />
          <small className="counter">{form.brandDescription.length}/{limits.maxContext}</small>
        </label>

        <label className="field">
          <span>Instruction for the engine <em>optional</em></span>
          <textarea rows={2} maxLength={limits.maxInstruction} value={form.instruction}
            placeholder="Focus on price comparisons and same-day delivery"
            onChange={(e) => set({ instruction: e.target.value })} />
          <small className="counter">{form.instruction.length}/{limits.maxInstruction} · steers topic, angle, audience or market only</small>
        </label>

        <label className="check-row">
          <input type="checkbox" checked={form.analyzeWebsite} disabled={!form.brandWebsite.trim()}
            onChange={(e) => set({ analyzeWebsite: e.target.checked })} />
          <span>Analyse the website during generation (adds offerings and audience to the context)</span>
        </label>
      </section>

      <button className="primary" type="submit" disabled={busy || !keywords.length || tooMany || (needsBrand && !form.brandName.trim())}>
        {busy ? 'Engine is working…' : `Generate ${total || ''} prompts`}
      </button>
    </form>
  );
}
