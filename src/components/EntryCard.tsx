import { useMemo, useState, type ReactNode } from 'react';
import type { Entry } from '../types';
import { KIND_INFO } from '../types';
import { highlight } from '../highlight';

const COLLAPSE = 1500;
const TAG_RE = /(<(ide_selection|system-reminder|ide_opened_file|ide_diagnostics)>[\s\S]*?<\/\2>)/g;

function fmtTime(ts?: string) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function Collapsible({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tag-block">
      <button className="link" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {label}
      </button>
      {open && <pre className="text">{children}</pre>}
    </div>
  );
}

export function EntryCard({
  e,
  re,
  isCurrent,
  onShowRaw,
  onGoto,
  onFocusTurn,
  forceOpen,
}: {
  e: Entry;
  re: RegExp | null;
  isCurrent: boolean;
  onShowRaw: (i: number) => void;
  onGoto: (uuidOrIndex: string | number) => void;
  onFocusTurn: (t: number) => void;
  forceOpen: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const info = KIND_INFO[e.kind];
  const long = e.text.length > COLLAPSE;
  const open = expanded || forceOpen;
  const shown = open || !long ? e.text : e.text.slice(0, COLLAPSE);

  const body = useMemo(() => {
    if (e.kind !== 'prompt') return <pre className="text">{highlight(shown, re)}</pre>;
    const parts = shown.split(TAG_RE);
    const nodes: ReactNode[] = [];
    for (let k = 0; k < parts.length; k++) {
      const p = parts[k];
      if (p == null || p === '') continue;
      if (k % 3 === 1) {
        const tag = parts[k + 1];
        nodes.push(
          <Collapsible key={k} label={`contexte <${tag}> (${p.length} car.)`}>
            {highlight(p, re)}
          </Collapsible>,
        );
        k++;
      } else if (k % 3 === 0) nodes.push(<pre key={k} className="text">{highlight(p, re)}</pre>);
    }
    return <>{nodes}</>;
  }, [shown, re, e.kind]);

  return (
    <article id={`e-${e.i}`} className={`card kind-${e.kind} ${e.isError ? 'error' : ''} ${isCurrent ? 'current' : ''} ${e.sidechain ? 'sidechain' : ''}`} style={{ ['--c' as string]: info.color }}>
      <header>
        <span className="kind-dot" />
        <span className="title">{e.title}</span>
        {e.sidechain && <span className="badge">sous-agent{e.agentId ? ` ${e.agentId.slice(0, 6)}` : ''}</span>}
        {e.isError && <span className="badge err">erreur</span>}
        {e.result?.interrupted && <span className="badge err">interrompu</span>}
        {e.permission && e.permission !== 'accept' && <span className="badge warn">permission : {e.permission}</span>}
        {e.model && <span className="badge dim">{e.model}</span>}
        {e.stopReason && e.stopReason !== 'tool_use' && e.stopReason !== 'end_turn' && <span className="badge warn">stop : {e.stopReason}</span>}
        {e.result?.durationMs != null && <span className="badge dim">{(e.result.durationMs / 1000).toFixed(1)} s</span>}
        <span className="spacer" />
        <button className="link" onClick={() => onFocusTurn(e.turn)} title="Ne voir que ce tour">
          tour {e.turn}
        </button>
        <span className="time" title={e.ts}>
          {fmtTime(e.ts)}
        </span>
        <span className="line" title="Numéro de ligne dans le fichier">
          L{e.i + 1}
        </span>
      </header>
      {e.thinking && (
        <Collapsible label="réflexion jointe">{highlight(e.thinking, re)}</Collapsible>
      )}
      {body}
      {e.heavy && (
        <div className="note">
          Aperçu tronqué ({e.fullChars?.toLocaleString('fr-FR')} caractères). Le texte complet est dans « JSON brut ». La recherche ne porte que sur cet aperçu.
        </div>
      )}
      {long && !forceOpen && (
        <button className="link more" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Réduire' : `Afficher tout (${e.text.length.toLocaleString('fr-FR')} car.)`}
        </button>
      )}
      <footer>
        <button className="link" onClick={() => onShowRaw(e.i)}>
          JSON brut
        </button>
        {e.parentUuid && (
          <button className="link" onClick={() => onGoto(e.parentUuid!)} title={e.parentUuid}>
            ↑ parent
          </button>
        )}
        {e.kind === 'tool_result' &&
          e.tools?.map((t) => (
            <button key={t.id} className="link" onClick={() => t.useIndex != null && onGoto(t.useIndex)} disabled={t.useIndex == null}>
              ↑ appel {t.name}
            </button>
          ))}
        {e.kind === 'tool_use' && (
          <button className="link" onClick={() => onGoto(`result:${e.i}`)}>
            ↓ résultat
          </button>
        )}
        {e.result?.filePath && <span className="dim">{e.result.filePath}</span>}
        {e.result?.url && <span className="dim">{e.result.url}</span>}
        {e.uuid && (
          <span className="dim mono" title={e.uuid}>
            {e.uuid.slice(0, 8)}
          </span>
        )}
      </footer>
    </article>
  );
}
