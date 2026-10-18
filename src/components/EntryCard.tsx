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
  onEdit,
  onDelete,
  onRestore,
  onInsert,
}: {
  e: Entry;
  re: RegExp | null;
  isCurrent: boolean;
  onShowRaw: (i: number) => void;
  onGoto: (uuidOrIndex: string | number) => void;
  onFocusTurn: (t: number) => void;
  forceOpen: boolean;
  onEdit: (e: Entry, text: string) => void;
  onDelete: (e: Entry) => void;
  onRestore: (e: Entry) => void;
  onInsert: (e: Entry, role: 'user' | 'assistant') => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const editable = !e.deleted && (e.kind === 'prompt' || e.kind === 'assistant' || e.kind === 'tool_result');
  const deletable = !e.deleted && !e.inserted && (e.kind === 'prompt' || e.kind === 'assistant' || e.kind === 'thinking' || e.kind === 'tool_use' || e.kind === 'tool_result');
  const insertable = !e.deleted && !e.inserted && !!e.uuid && (e.kind === 'prompt' || e.kind === 'assistant' || e.kind === 'tool_result');
  const [expanded, setExpanded] = useState(false);
  const info = KIND_INFO[e.kind];
  const open = expanded || forceOpen;

  // Pour les prompts : les balises de contexte (<ide_selection>, <system-reminder>…) sont repliées,
  // et la troncature ne s'applique qu'au texte « humain » restant.
  const { body, long, plainLen } = useMemo(() => {
    const parts = e.kind === 'prompt' ? e.text.split(TAG_RE) : [e.text];
    const plain: string[] = [];
    const segs: { tag?: string; text: string }[] = [];
    for (let k = 0; k < parts.length; k++) {
      const p = parts[k];
      if (k % 3 === 1) {
        segs.push({ tag: parts[k + 1], text: p });
        k++;
      } else if (p) {
        segs.push({ text: p });
        plain.push(p);
      }
    }
    const plainLen = plain.reduce((a, s) => a + s.length, 0);
    const long = plainLen > COLLAPSE;
    let budget = open || !long ? Infinity : COLLAPSE;
    const nodes: ReactNode[] = [];
    segs.forEach((sg, k) => {
      if (sg.tag) {
        nodes.push(
          <Collapsible key={k} label={`contexte <${sg.tag}> (${sg.text.length.toLocaleString('fr-FR')} car.)`}>
            {highlight(sg.text, re)}
          </Collapsible>,
        );
      } else if (budget > 0) {
        const t = sg.text.length > budget ? sg.text.slice(0, budget) : sg.text;
        budget -= t.length;
        nodes.push(
          <pre key={k} className="text">
            {highlight(t, re)}
          </pre>,
        );
      }
    });
    return { body: <>{nodes}</>, long, plainLen };
  }, [e.text, e.kind, re, open]);

  return (
    <article id={`e-${e.i}`} className={`card kind-${e.kind} ${e.isError ? 'error' : ''} ${isCurrent ? 'current' : ''} ${e.sidechain ? 'sidechain' : ''} ${e.deleted ? 'deleted' : ''} ${e.inserted ? 'inserted' : ''} ${e.edited ? 'edited' : ''}`} style={{ ['--c' as string]: info.color }}>
      <header>
        <span className="kind-dot" />
        <span className="title">{e.title}</span>
        {e.inserted && <span className="badge new">nouveau</span>}
        {e.edited && <span className="badge edit">modifié</span>}
        {e.deleted && <span className="badge err">supprimé</span>}
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
        {e.i >= 0 && (
          <span className="line" title="Numéro de ligne dans le fichier">
            L{e.i + 1}
          </span>
        )}
      </header>
      {e.thinking && (
        <Collapsible label="réflexion jointe">{highlight(e.thinking, re)}</Collapsible>
      )}
      {editing ? (
        <div className="editor">
          <textarea value={draft} onChange={(ev) => setDraft(ev.target.value)} rows={Math.min(24, Math.max(4, draft.split('\n').length + 1))} autoFocus />
          <div className="row">
            <button
              className="primary"
              onClick={() => {
                onEdit(e, draft);
                setEditing(false);
              }}
            >
              Appliquer
            </button>
            <button onClick={() => setEditing(false)}>Annuler</button>
            {e.kind === 'prompt' && <span className="hint">Les balises &lt;ide_selection&gt; / &lt;system-reminder&gt; font partie du texte : tu peux les retirer.</span>}
            {e.kind === 'tool_result' && <span className="hint">Remplace le contenu renvoyé à Claude par l'outil.</span>}
          </div>
        </div>
      ) : (
        body
      )}
      {e.heavy && (
        <div className="note">
          Aperçu tronqué ({e.fullChars?.toLocaleString('fr-FR')} caractères). Le texte complet est dans « JSON brut ». La recherche ne porte que sur cet aperçu.
        </div>
      )}
      {long && !forceOpen && (
        <button className="link more" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Réduire' : `Afficher tout (${plainLen.toLocaleString('fr-FR')} car.)`}
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
        <span className="spacer" />
        {editable && !editing && (
          <button
            className="link act"
            onClick={() => {
              setDraft(e.text);
              setEditing(true);
            }}
          >
            ✎ Modifier
          </button>
        )}
        {insertable && (
          <>
            <button className="link act" onClick={() => onInsert(e, 'user')} title="Insérer un prompt utilisateur après cette entrée">
              + prompt après
            </button>
            <button className="link act" onClick={() => onInsert(e, 'assistant')} title="Insérer une réponse de Claude après cette entrée">
              + réponse après
            </button>
          </>
        )}
        {deletable && (
          <button className="link act danger-link" onClick={() => onDelete(e)} title={e.kind === 'tool_use' || e.kind === 'tool_result' ? "L'appel et son résultat sont supprimés ensemble" : 'Supprimer cette entrée'}>
            ✕ Supprimer
          </button>
        )}
        {e.inserted && (
          <button className="link act danger-link" onClick={() => onDelete(e)}>
            ✕ Retirer
          </button>
        )}
        {e.deleted && (
          <button className="link act" onClick={() => onRestore(e)}>
            ↶ Rétablir
          </button>
        )}
      </footer>
    </article>
  );
}
