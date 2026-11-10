export default function History({ runs, activeId, onOpen, onDelete }) {
  if (!runs.length) return null;
  return (
    <div className="card history">
      <h3>Recent runs</h3>
      <ul>
        {runs.map((r) => (
          <li key={r.id} className={r.id === activeId ? 'active' : ''}>
            <button type="button" className="open" onClick={() => onOpen(r.id)}>
              <span className="name">{r.name}</span>
              <span className="muted">
                {r.status === 'done' ? `${r.stats?.total ?? 0} prompts` : r.status} · {new Date(r.createdAt).toLocaleDateString()}
              </span>
            </button>
            <button type="button" className="icon" title="Delete run" onClick={() => onDelete(r.id)}>✕</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
