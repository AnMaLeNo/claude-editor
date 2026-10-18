import { useRef, useState } from 'react';
import type { Source } from '../types';

function fmtSize(b: number) {
  return b < 1024 ? `${b} o` : b < 1048576 ? `${(b / 1024).toFixed(0)} Ko` : `${(b / 1048576).toFixed(1)} Mo`;
}
function fmtDate(s?: string) {
  if (!s) return '';
  const d = new Date(s);
  return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const GROUP_LABEL = { local: 'Sessions Claude Code (~/.claude)', uploads: 'Fichiers déposés', clones: 'Clones' } as const;

export function Sidebar({
  sessions,
  selected,
  onSelect,
  onUpload,
  onRefresh,
  busy,
}: {
  sessions: Source[];
  selected?: string;
  onSelect: (key: string) => void;
  onUpload: (f: File) => void;
  onRefresh: () => void;
  busy: boolean;
}) {
  const [q, setQ] = useState('');
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const ql = q.toLowerCase();
  const filtered = sessions.filter((s) => !ql || [s.title, s.firstPrompt, s.project, s.cwd, s.fileId, s.gitBranch].join(' ').toLowerCase().includes(ql));
  const groups = (['uploads', 'clones', 'local'] as const).map((g) => ({ g, items: filtered.filter((s) => s.group === g) })).filter((x) => x.items.length);

  return (
    <aside
      className={`sidebar ${drag ? 'drag' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer.files[0];
        if (f) onUpload(f);
      }}
    >
      <div className="sidebar-head">
        <h1>Claude Sessions</h1>
        <div className="row">
          <button className="primary" onClick={() => fileRef.current?.click()} disabled={busy}>
            + Ouvrir un .jsonl
          </button>
          <button onClick={onRefresh} title="Relire les dossiers" disabled={busy}>
            ↻
          </button>
        </div>
        <input ref={fileRef} type="file" accept=".jsonl,.txt,application/jsonl" hidden onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])} />
        <input className="search-small" placeholder="Filtrer les sessions…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="hint">Glisse un fichier ici pour l'ouvrir.</div>
      </div>
      <div className="sidebar-list">
        {sessions.length === 0 && <div className="empty">Aucune session trouvée. Dépose un fichier .jsonl.</div>}
        {groups.map(({ g, items }) => (
          <div key={g} className="group">
            <div className="group-title">
              {GROUP_LABEL[g]} <span className="count">{items.length}</span>
            </div>
            {items.map((s) => (
              <button key={s.key} className={`session ${selected === s.key ? 'active' : ''}`} onClick={() => onSelect(s.key)}>
                <div className="session-title">
                  {s.title ?? s.firstPrompt ?? s.fileName}
                  {s.forkedFrom && <span className="badge clone">clone</span>}
                  {s.idMismatch && <span className="badge warn" title="Le sessionId dans le fichier ne correspond pas au nom du fichier">id ≠ nom</span>}
                  {s.error && <span className="badge warn">erreur</span>}
                </div>
                <div className="session-sub">
                  {s.project ? <span title={s.cwd}>{s.cwd ?? s.project}</span> : <span>{s.fileName}</span>}
                </div>
                <div className="session-sub">
                  {fmtDate(s.last ?? s.mtime)} · {s.turns ?? '?'} tour{(s.turns ?? 0) > 1 ? 's' : ''} · {s.lines ?? '?'} lignes · {fmtSize(s.size)}
                  {s.gitBranch && s.gitBranch !== 'HEAD' ? ` · ${s.gitBranch}` : ''}
                </div>
              </button>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}
