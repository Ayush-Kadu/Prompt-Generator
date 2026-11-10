import { useMemo, useState } from 'react';
import { brandMatcher, promptKey } from '../utils.js';

const PAGE = 100;
const INTENT_LIST = ['informational', 'commercial', 'transactional', 'comparison', 'local', 'review', 'navigational'];
const gradeOf = (s) => (s >= 85 ? 'A' : s >= 70 ? 'B' : s >= 50 ? 'C' : 'D');

export default function ResultsTable({ run, meta, prompts, setPrompts, onSave, onExport, dirty, saving, exporting }) {
  const [filter, setFilter] = useState({ q: '', category: '', intent: '', sentiment: '', keyword: '', grade: '' });
  const [sortByScore, setSortByScore] = useState(false);
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState(null);
  const [custom, setCustom] = useState({ text: '', keyword: '' });
  const [note, setNote] = useState('');

  const settings = run?.settings || {};
  const keywords = run?.keywords?.length ? run.keywords : settings.keywords || [];
  const isBranded = useMemo(
    () => brandMatcher({ name: settings.brand?.name, website: settings.brand?.website, aliases: (settings.brand?.aliases || []).join(',') }),
    [settings.brand],
  );

  const options = useMemo(() => {
    const uniq = (f) => [...new Set(prompts.map((p) => p[f]).filter(Boolean))].sort();
    return { intent: uniq('intent'), sentiment: uniq('sentiment'), keyword: uniq('keyword') };
  }, [prompts]);

  const filtered = useMemo(() => {
    const q = filter.q.toLowerCase();
    const list = prompts.filter((p) =>
      (!q || p.text.toLowerCase().includes(q)) &&
      (!filter.category || p.category === filter.category) &&
      (!filter.intent || p.intent === filter.intent) &&
      (!filter.sentiment || p.sentiment === filter.sentiment) &&
      (!filter.keyword || p.keyword === filter.keyword) &&
      (!filter.grade || p.grade === filter.grade));
    return sortByScore ? [...list].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)) : list;
  }, [prompts, filter, sortByScore]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const current = Math.min(page, pages - 1);
  const visible = filtered.slice(current * PAGE, current * PAGE + PAGE);
  const selectedCount = prompts.filter((p) => p.selected).length;
  const allFilteredSelected = filtered.length > 0 && filtered.every((p) => p.selected);
  const scored = prompts.filter((p) => typeof p.score === 'number');
  const avg = scored.length ? Math.round(scored.reduce((a, p) => a + p.score, 0) / scored.length) : null;
  const counts = {
    branded: prompts.filter((p) => p.category === 'Branded').length,
    nonBranded: prompts.filter((p) => p.category === 'Non-branded').length,
  };

  const setF = (patch) => { setFilter((f) => ({ ...f, ...patch })); setPage(0); };
  const update = (id, patch) => setPrompts((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const remove = (id) => setPrompts((list) => list.filter((p) => p.id !== id));
  const toggleAll = () => {
    const ids = new Set(filtered.map((p) => p.id));
    setPrompts((list) => list.map((p) => (ids.has(p.id) ? { ...p, selected: !allFilteredSelected } : p)));
  };
  const selectAbove = (min) => setPrompts((list) => list.map((p) => ({ ...p, selected: (p.score ?? 100) >= min })));

  // Edited and custom prompts lose their engine score; they show "—" until re-scored by a new run.
  const saveEdit = () => {
    const text = editing.text.trim();
    if (!text) return;
    if (prompts.some((p) => p.id !== editing.id && promptKey(p.text) === promptKey(text))) { setNote('That prompt already exists.'); return; }
    update(editing.id, { text, category: isBranded(text) ? 'Branded' : 'Non-branded', score: undefined, grade: undefined, flags: ['edited'] });
    setEditing(null);
    setNote('');
  };

  const addCustom = (e) => {
    e.preventDefault();
    const text = custom.text.trim();
    if (!text) return;
    if (prompts.some((p) => promptKey(p.text) === promptKey(text))) { setNote('That prompt already exists.'); return; }
    setPrompts((list) => [{
      id: crypto.randomUUID(), text, keyword: custom.keyword || '', category: isBranded(text) ? 'Branded' : 'Non-branded',
      intent: '', sentiment: '', flags: [], topic: settings.topic || '', location: settings.location || '', language: settings.language || 'English',
      source: 'custom', selected: true,
    }, ...list]);
    setCustom({ text: '', keyword: custom.keyword });
    setNote('Added.');
  };

  const profile = run?.profile;

  return (
    <div className="card results">
      <div className="results-head">
        <div>
          <h2>{run?.name}</h2>
          <p className="muted">
            {prompts.length} prompts · {counts.nonBranded} non-branded · {counts.branded} branded
            {avg !== null ? ` · avg quality ${avg}` : ''}
            {run?.stats?.duplicates ? ` · ${run.stats.duplicates} duplicates removed` : ''}
            {run?.provider ? ` · ${run.provider}/${run.model}` : ''}
            {run?.usage?.outputTokens ? ` · ${run.usage.inputTokens + run.usage.outputTokens} tokens` : ''}
          </p>
        </div>
        <div className="actions">
          <button type="button" onClick={onSave} disabled={!dirty || saving}>{saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}</button>
          <button type="button" onClick={() => onExport('csv')} disabled={!selectedCount || exporting}>CSV</button>
          <button type="button" className="primary" onClick={() => onExport('xlsx')} disabled={!selectedCount || exporting}>
            {exporting ? 'Exporting…' : `Export ${selectedCount} to Excel`}
          </button>
        </div>
      </div>

      {profile && (
        <details className="profile">
          <summary>Brand profile ({profile.source === 'llm' ? 'AI analysis' : 'page metadata'})</summary>
          {profile.industry && <p><b>Industry:</b> {profile.industry}</p>}
          {profile.description && <p><b>About:</b> {profile.description}</p>}
          {profile.offerings?.length > 0 && <p><b>Offers:</b> {profile.offerings.join(', ')}</p>}
          {profile.audience?.length > 0 && <p><b>Audience:</b> {profile.audience.join(', ')}</p>}
          {profile.competitors?.length > 0 && <p><b>Competitors:</b> {profile.competitors.join(', ')}</p>}
        </details>
      )}

      <form className="add-row" onSubmit={addCustom}>
        <input value={custom.text} placeholder="Add your own prompt…" maxLength={400} aria-label="Custom prompt" onChange={(e) => setCustom({ ...custom, text: e.target.value })} />
        <select value={custom.keyword} aria-label="Keyword for custom prompt" onChange={(e) => setCustom({ ...custom, keyword: e.target.value })}>
          <option value="">No keyword</option>
          {keywords.map((k) => <option key={k}>{k}</option>)}
        </select>
        <button type="submit" disabled={!custom.text.trim()}>Add</button>
      </form>
      {note && <p className="note">{note}</p>}

      <div className="filters">
        <input placeholder="Search prompts" value={filter.q} aria-label="Search prompts" onChange={(e) => setF({ q: e.target.value })} />
        <select value={filter.category} aria-label="Category" onChange={(e) => setF({ category: e.target.value })}>
          <option value="">All categories</option><option>Non-branded</option><option>Branded</option>
        </select>
        {['intent', 'sentiment', 'keyword'].map((f) => (
          <select key={f} value={filter[f]} aria-label={f} onChange={(e) => setF({ [f]: e.target.value })}>
            <option value="">All {f === 'keyword' ? 'keywords' : `${f}s`}</option>
            {options[f].map((o) => <option key={o}>{o}</option>)}
          </select>
        ))}
        <select value={filter.grade} aria-label="Grade" onChange={(e) => setF({ grade: e.target.value })}>
          <option value="">All grades</option>{['A', 'B', 'C', 'D'].map((g) => <option key={g}>{g}</option>)}
        </select>
      </div>
      <div className="quick">
        <span className="muted">Select:</span>
        <button type="button" className="link" onClick={() => selectAbove(0)}>all</button>
        <button type="button" className="link" onClick={() => selectAbove(70)}>score 70+</button>
        <button type="button" className="link" onClick={() => selectAbove(85)}>score 85+</button>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="check"><input type="checkbox" checked={allFilteredSelected} onChange={toggleAll} aria-label="Select all shown" /></th>
              <th>Prompt</th><th>Keyword</th><th>Category</th><th>Intent</th><th>Sentiment</th>
              <th><button type="button" className="th-sort" onClick={() => setSortByScore((s) => !s)} aria-pressed={sortByScore}>Score {sortByScore ? '↓' : '↕'}</button></th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => (
              <tr key={p.id} className={p.selected ? '' : 'off'}>
                <td className="check"><input type="checkbox" checked={p.selected} onChange={() => update(p.id, { selected: !p.selected })} aria-label="Select prompt" /></td>
                <td className="prompt">
                  {editing?.id === p.id ? (
                    <div className="edit">
                      <input autoFocus value={editing.text} aria-label="Edit prompt" onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditing(null); }} />
                      <button type="button" onClick={saveEdit}>OK</button>
                    </div>
                  ) : (
                    <span onDoubleClick={() => setEditing({ id: p.id, text: p.text })}>{p.text}</span>
                  )}
                  {p.source !== 'ai' && <span className="tag">{p.source}</span>}
                </td>
                <td>{p.keyword}</td>
                <td><span className={`badge ${p.category === 'Branded' ? 'b' : 'nb'}`}>{p.category}</span></td>
                <td>
                  <select className="inline" value={p.intent || ''} aria-label="Intent" onChange={(e) => update(p.id, { intent: e.target.value })}>
                    <option value="">—</option>
                    {(meta ? Object.keys(meta.intents) : INTENT_LIST).map((i) => <option key={i}>{i}</option>)}
                  </select>
                </td>
                <td>{p.sentiment || '—'}</td>
                <td>
                  {typeof p.score === 'number'
                    ? <span className={`score g${p.grade || gradeOf(p.score)}`} title={p.flags?.length ? `Flags: ${p.flags.join(', ')}` : 'No issues'}>{p.score}</span>
                    : <span className="muted">—</span>}
                </td>
                <td className="row-actions">
                  <button type="button" className="icon" title="Edit" aria-label="Edit prompt" onClick={() => setEditing({ id: p.id, text: p.text })}>✎</button>
                  <button type="button" className="icon" title="Delete" aria-label="Delete prompt" onClick={() => remove(p.id)}>✕</button>
                </td>
              </tr>
            ))}
            {!visible.length && <tr><td colSpan={8} className="empty">No prompts match these filters.</td></tr>}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="pager">
          <button type="button" disabled={current === 0} onClick={() => setPage(current - 1)}>‹ Prev</button>
          <span>Page {current + 1} of {pages} · {filtered.length} shown</span>
          <button type="button" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>Next ›</button>
        </div>
      )}
    </div>
  );
}
