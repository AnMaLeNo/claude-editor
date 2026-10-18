import { useEffect, useState } from 'react';
import type { AiRoute, AiRoutes, AiSearchResult, Entry } from '../types';
import { api } from '../api';
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
  onRun: (q: string, includeMeta: boolean, scope: string, type: string) => void;
  onGoto: (i: number) => void;
  selected: Set<number>;
  onToggle: (i: number) => void;
  onSelectAll: (is: number[]) => void;
  onEditSelection: () => void;
}) {
  const [q, setQ] = useState('');
  const [includeMeta, setIncludeMeta] = useState(false);
  const [minScore, setMinScore] = useState(1.5);
  const [routes, setRoutes] = useState<AiRoutes | null>(null);
  const [route, setRoute] = useState<AiRoute | null>(null);
  const [scope, setScope] = useState('tout');
  const [type, setType] = useState('general');
  const [routing, setRouting] = useState(false);
  const [routeErr, setRouteErr] = useState('');
  useEffect(() => {
    api.aiRoutes().then(setRoutes).catch(() => setRoutes(null));
  }, []);
  // 1) un premier JEV classe la recherche (portée + type), 2) la recherche part avec les questions propres à ce type
  const analyseAndRun = async () => {
    if (!q.trim() || running || routing) return;
    setRouting(true);
    setRouteErr('');
    try {
      const r = await api.aiRoute(q.trim());
      setRoute(r);
      setScope(r.scope);
      setType(r.type);
      onRun(q.trim(), includeMeta, r.scope, r.type);
    } catch (e) {
      setRouteErr((e as Error).message);
    } finally {
      setRouting(false);
    }
  };
  const pct = (m: Record<string, number> | undefined, k: string) => Math.round(((m ?? {})[k] ?? 0) * 100);
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
          onKeyDown={(e) => e.key === 'Enter' && analyseAndRun()}
        />
        <button className="primary" disabled={running || routing || !q.trim()} onClick={analyseAndRun} title="JEV classe d'abord ta recherche (portée + type), puis l'applique à la conversation">
          {routing ? 'JEV classe la recherche…' : running ? 'JEV analyse…' : 'Rechercher avec JEV'}
        </button>
        <label className="opt" title="Inclure les lignes techniques et le contexte injecté">
          <input type="checkbox" checked={includeMeta} onChange={(e) => setIncludeMeta(e.target.checked)} /> technique + contexte
        </label>
      </div>
      {routeErr && <div className="hint err">Routage impossible : {routeErr}</div>}
      {routes && (route || result) && (
        <div className="row ai-route">
          <span className="dim">Routage JEV :</span>
          <label className="opt" title={route ? Object.entries(routes.scopes).map(([k, v]) => `${v.label} ${pct(route.scopeP, k)} %`).join(' · ') : ''}>
            portée
            <select value={scope} onChange={(e) => setScope(e.target.value)} className={route && pct(route.scopeP, route.scope) < 70 && scope === route.scope ? 'warn' : ''}>
              {Object.entries(routes.scopes).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                  {route ? ` (${pct(route.scopeP, k)} %)` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="opt" title={route ? Object.entries(routes.types).map(([k, v]) => `${v.label} ${pct(route.typeP, k)} %`).join(' · ') : ''}>
            type
            <select value={type} onChange={(e) => setType(e.target.value)} className={route && pct(route.typeP, route.type) < 70 && type === route.type ? 'warn' : ''}>
              {Object.entries(routes.types).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                  {route ? ` (${pct(route.typeP, k)} %)` : ''}
                </option>
              ))}
            </select>
          </label>
          {(scope !== (result?.scope ?? route?.scope) || type !== (result?.type ?? route?.type)) && (
            <button className="chip link" disabled={running || !q.trim()} onClick={() => onRun(q.trim(), includeMeta, scope, type)}>
              relancer avec ce routage
            </button>
          )}
          <span className="hint">{routes.types[type]?.desc}</span>
        </div>
      )}
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
