import { useState } from 'react';
import type { AiSearchResult, Entry } from '../types';
import { KIND_INFO } from '../types';

export function AiSearchPanel({
  result,
  entries,
  running,
  progress,
  onRun,
  onGoto,
  selected,
  onToggle,
  onSelectAll,
  onEditSelection,
}: {
  result: AiSearchResult | null;
  entries: Entry[];
  running: boolean;
  progress: string;
  onRun: (q: string, includeMeta: boolean) => void;
  onGoto: (i: number) => void;
  selected: Set<number>;
  onToggle: (i: number) => void;
  onSelectAll: (is: number[]) => void;
  onEditSelection: () => void;
}) {
  const [q, setQ] = useState('');
  const [includeMeta, setIncludeMeta] = useState(false);
  const [minScore, setMinScore] = useState(1.5);
  const byI = new Map(entries.map((e) => [e.i, e]));
  const shown = (result?.hits ?? []).filter((h) => h.score >= minScore && byI.has(h.i));
  return (
    <div className="ai-panel">
      <div className="row">
        <input
          className="search"
          placeholder="Décris ce que tu cherches (ex. « les moments où Claude a modifié un fichier de config », « les erreurs de compilation »…)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && q.trim() && !running && onRun(q.trim(), includeMeta)}
        />
        <button className="primary" disabled={running || !q.trim()} onClick={() => onRun(q.trim(), includeMeta)}>
          {running ? 'JEV analyse…' : 'Rechercher avec JEV'}
        </button>
        <label className="opt" title="Inclure les lignes techniques et le contexte injecté">
          <input type="checkbox" checked={includeMeta} onChange={(e) => setIncludeMeta(e.target.checked)} /> technique + contexte
        </label>
      </div>
      {running && <div className="hint">{progress || 'Envoi des lots à JEV…'}</div>}
      {result && (
        <>
          <div className="row ai-meta">
            <span>
              <b>{shown.length}</b> entrée{shown.length > 1 ? 's' : ''} au-dessus du seuil · {result.scanned} analysées en {result.batches} lot{result.batches > 1 ? 's' : ''} · {result.inputTokens.toLocaleString('fr-FR')} tokens · {result.costUSD.toFixed(4)} $ · {result.model}
            </span>
            <span className="spacer" />
            <label className="opt">
              Seuil de pertinence
              <input type="range" min={0} max={3} step={0.1} value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} />
              <b>{minScore.toFixed(1)}</b> / 3
            </label>
            <button className="chip link" onClick={() => onSelectAll(shown.map((h) => h.i))}>
              tout cocher
            </button>
            <button className="primary" disabled={!selected.size} onClick={onEditSelection}>
              Modifier la sélection avec l'IA ({selected.size})
            </button>
          </div>
          <div className="hint">Échelle : {result.scale.map((s, k) => `${k} = ${s}`).join(' · ')}. « p » = probabilité JEV que l'entrée corresponde directement.</div>
          <div className="ai-hits">
            {shown.length === 0 && <div className="empty">Rien au-dessus du seuil — baisse le curseur ou reformule.</div>}
            {shown.map((h) => {
              const e = byI.get(h.i)!;
              const info = KIND_INFO[e.kind];
              return (
                <div key={h.i} className="ai-hit" style={{ ['--c' as string]: info.color }}>
                  <input type="checkbox" checked={selected.has(h.i)} onChange={() => onToggle(h.i)} disabled={!(e.kind === 'prompt' || e.kind === 'assistant' || e.kind === 'tool_result')} title={e.kind === 'prompt' || e.kind === 'assistant' || e.kind === 'tool_result' ? 'Sélectionner pour modification IA' : 'Type non modifiable'} />
                  <span className="kind-dot" />
                  <button className="link" onClick={() => onGoto(h.i)}>
                    L{h.line} · {e.title}
                  </button>
                  <span className="dim">tour {e.turn}</span>
                  <span className="score" title={`score ${h.score.toFixed(2)} / 3 — confiance ${Math.round(h.confidence * 100)} %`}>
                    <span className="bar" style={{ width: `${(h.score / 3) * 100}%` }} />
                    <span>{h.score.toFixed(1)}</span>
                  </span>
                  <span className="dim">p={Math.round(h.p * 100)} %</span>
                  <span className="excerpt">{e.text.replace(/\s+/g, ' ').slice(0, 160)}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
