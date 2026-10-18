import type { Kind, Stats } from '../types';
import { KIND_INFO } from '../types';

export interface Filters {
  q: string;
  regex: boolean;
  caseSensitive: boolean;
  word: boolean;
  kinds: Set<Kind>;
  tools: Set<string>;
  errorsOnly: boolean;
  includeSidechain: boolean;
  from: string;
  to: string;
  turn: number | null;
}

export const DEFAULT_KINDS = new Set<Kind>(['prompt', 'assistant', 'thinking', 'tool_use', 'tool_result', 'system', 'summary']);

export function Toolbar({
  f,
  set,
  stats,
  matches,
  shown,
  total,
  onPrev,
  onNext,
  current,
}: {
  f: Filters;
  set: (p: Partial<Filters>) => void;
  stats: Stats;
  matches: number;
  shown: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  current: number;
}) {
  const toggleKind = (k: Kind) => {
    const s = new Set(f.kinds);
    if (s.has(k)) s.delete(k);
    else s.add(k);
    set({ kinds: s });
  };
  const toggleTool = (t: string) => {
    const s = new Set(f.tools);
    if (s.has(t)) s.delete(t);
    else s.add(t);
    set({ tools: s });
  };
  const toolNames = Object.entries(stats.tools).sort((a, b) => b[1] - a[1]);
  return (
    <div className="toolbar">
      <div className="row search-row">
        <input
          className="search"
          placeholder="Rechercher dans la conversation… (Entrée = suivant, Maj+Entrée = précédent)"
          value={f.q}
          onChange={(e) => set({ q: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.shiftKey ? onPrev : onNext)();
          }}
          autoFocus
        />
        <label className="opt" title="Expression régulière (JavaScript)">
          <input type="checkbox" checked={f.regex} onChange={(e) => set({ regex: e.target.checked })} /> .*
        </label>
        <label className="opt" title="Respecter la casse">
          <input type="checkbox" checked={f.caseSensitive} onChange={(e) => set({ caseSensitive: e.target.checked })} /> Aa
        </label>
        <label className="opt" title="Mot entier">
          <input type="checkbox" checked={f.word} onChange={(e) => set({ word: e.target.checked })} /> ⌶mot⌶
        </label>
        <div className="matches">
          {f.q ? (
            <>
              <b>{matches}</b> entrée{matches > 1 ? 's' : ''} {matches ? `· ${current + 1}/${matches}` : ''}
              <button onClick={onPrev} disabled={!matches} title="Précédent (Maj+Entrée)">
                ▲
              </button>
              <button onClick={onNext} disabled={!matches} title="Suivant (Entrée)">
                ▼
              </button>
            </>
          ) : (
            <span>
              {shown} / {total} entrées affichées
            </span>
          )}
        </div>
      </div>
      <div className="row chips">
        {(Object.keys(KIND_INFO) as Kind[]).map((k) => (
          <button
            key={k}
            className={`chip ${f.kinds.has(k) ? 'on' : ''}`}
            style={{ ['--c' as string]: KIND_INFO[k].color }}
            onClick={() => toggleKind(k)}
            title={KIND_INFO[k].help}
          >
            <span className="dot" /> {KIND_INFO[k].label} <span className="count">{stats.byKind[k]}</span>
          </button>
        ))}
        <span className="sep" />
        <button className="chip link" onClick={() => set({ kinds: new Set(Object.keys(KIND_INFO) as Kind[]) })}>
          tout
        </button>
        <button className="chip link" onClick={() => set({ kinds: new Set(DEFAULT_KINDS) })}>
          conversation
        </button>
        <button className="chip link" onClick={() => set({ kinds: new Set<Kind>(['prompt', 'assistant']) })}>
          dialogue seul
        </button>
      </div>
      <div className="row chips">
        <span className="label">Outils :</span>
        {toolNames.length === 0 && <span className="hint">aucun appel d'outil</span>}
        {toolNames.map(([t, n]) => (
          <button key={t} className={`chip tool ${f.tools.has(t) ? 'on' : ''}`} onClick={() => toggleTool(t)} title={`Filtrer sur les appels/résultats ${t}`}>
            {t} <span className="count">{n}</span>
          </button>
        ))}
        {f.tools.size > 0 && (
          <button className="chip link" onClick={() => set({ tools: new Set() })}>
            effacer
          </button>
        )}
        <span className="sep" />
        <label className="opt">
          <input type="checkbox" checked={f.errorsOnly} onChange={(e) => set({ errorsOnly: e.target.checked })} /> erreurs seulement{' '}
          <span className="count">{stats.errors}</span>
        </label>
        <label className="opt" title="Lignes produites par les sous-agents (isSidechain)">
          <input type="checkbox" checked={f.includeSidechain} onChange={(e) => set({ includeSidechain: e.target.checked })} /> sous-agents{' '}
          <span className="count">{stats.sidechain}</span>
        </label>
        <span className="sep" />
        <label className="opt">
          du <input type="datetime-local" value={f.from} onChange={(e) => set({ from: e.target.value })} />
        </label>
        <label className="opt">
          au <input type="datetime-local" value={f.to} onChange={(e) => set({ to: e.target.value })} />
        </label>
        {(f.from || f.to) && (
          <button className="chip link" onClick={() => set({ from: '', to: '' })}>
            effacer dates
          </button>
        )}
        {f.turn != null && (
          <button className="chip on" style={{ ['--c' as string]: '#4f8cff' }} onClick={() => set({ turn: null })}>
            Tour {f.turn} ✕
          </button>
        )}
      </div>
    </div>
  );
}
