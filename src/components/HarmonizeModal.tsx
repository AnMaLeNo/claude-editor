import { useMemo, useState } from 'react';
import type { Entry, HarmonizeItem, HarmonizeRole } from '../types';
import { api } from '../api';
import { Modal } from './Modal';

type Proposal = { e: Entry; status: 'pending' | 'running' | 'done' | 'error'; text?: string; changed?: boolean; error?: string; accepted?: boolean; contextMessages?: number };
type Scope = 'after_edit' | 'all' | 'selected';

const CONTEXT = [
  { v: 20000, label: 'court (≈ 20 k caractères)' },
  { v: 60000, label: 'moyen (≈ 60 k caractères)' },
  { v: 150000, label: 'long (≈ 150 k caractères)' },
];

const roleOf = (e: Entry): HarmonizeRole | null =>
  e.kind === 'prompt' ? 'user' : e.kind === 'assistant' ? 'assistant' : e.kind === 'tool_use' ? 'tool_call' : e.kind === 'tool_result' ? 'tool_result' : null;

export function HarmonizeModal({ entries, firstEditedI, selected, onClose, onAccept }: { entries: Entry[]; firstEditedI: number | null; selected: Set<number>; onClose: () => void; onAccept: (e: Entry, text: string) => void }) {
  const [scope, setScope] = useState<Scope>(firstEditedI != null ? 'after_edit' : selected.size ? 'selected' : 'all');
  const [direction, setDirection] = useState('');
  const [contextChars, setContextChars] = useState(60000);
  const [withTools, setWithTools] = useState(true);
  const [props, setProps] = useState<Proposal[] | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cost, setCost] = useState<number | null>(null);

  // transcription = dialogue principal, modifications en attente incluses, dans l'ordre du fichier
  const transcript = useMemo(
    () => entries.filter((e) => !e.deleted && !e.sidechain && roleOf(e) && e.text.trim() && (withTools || (e.kind !== 'tool_use' && e.kind !== 'tool_result'))),
    [entries, withTools],
  );
  const targets = useMemo(() => {
    const resp = transcript.filter((e) => e.kind === 'assistant' && !e.inserted);
    if (scope === 'selected') return resp.filter((e) => selected.has(e.i));
    if (scope === 'after_edit' && firstEditedI != null) return resp.filter((e) => e.i > firstEditedI);
    return resp;
  }, [transcript, scope, selected, firstEditedI]);

  const run = async () => {
    setRunning(true);
    setErr(null);
    setCost(null);
    setProps(targets.map((e, k) => ({ e, status: k === 0 ? 'running' : 'pending' })));
    try {
      const { jobId } = await api.aiHarmonize({
        transcript: transcript.map((e) => ({ ref: String(e.i), role: roleOf(e)!, text: e.text })),
        targets: targets.map((e) => String(e.i)),
        direction: direction.trim(),
        contextChars,
        toolChars: 4000,
      });
      const apply = (items: HarmonizeItem[]) =>
        setProps((old) => {
          const next = (old ?? []).map((p) => {
            const it = items.find((x) => x.ref === String(p.e.i));
            if (!it) return p.status === 'done' || p.status === 'error' ? p : { ...p, status: 'pending' as const };
            if (p.status === 'done' || p.status === 'error') return p;
            return it.ok ? { e: p.e, status: 'done' as const, text: it.text, changed: it.changed, accepted: false, contextMessages: it.contextMessages } : { e: p.e, status: 'error' as const, error: it.error ?? 'Pas de résultat' };
          });
          const k = next.findIndex((p) => p.status === 'pending');
          if (k >= 0) next[k] = { ...next[k], status: 'running' };
          return next;
        });
      const res = await api.waitJob<{ items: HarmonizeItem[] }>(jobId, (p) => apply(p as HarmonizeItem[]));
      apply(res.items);
      setCost(res.items.reduce((a, it) => a + (it.costUSD ?? 0), 0));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  };
  const accept = (k: number) => {
    const p = props?.[k];
    if (!p || p.status !== 'done' || p.text == null || p.accepted) return;
    onAccept(p.e, p.text);
    setProps((old) => (old ?? []).map((x, j) => (j === k ? { ...x, accepted: true } : x)));
  };
  const acceptAllChanged = () => props?.forEach((p, k) => p.status === 'done' && p.changed && !p.accepted && accept(k));
  const done = props?.filter((p) => p.status === 'done' || p.status === 'error').length ?? 0;
  const changed = props?.filter((p) => p.status === 'done' && p.changed && !p.accepted).length ?? 0;
  const nSelectedResp = [...selected].filter((i) => entries.find((e) => e.i === i)?.kind === 'assistant').length;

  return (
    <Modal title="Harmoniser les réponses de Claude" onClose={onClose}>
      <div className="ai-edit">
        <p className="help">
          Après tes modifications (résultats d'outils, prompts…), les réponses de Claude peuvent ne plus coller. Chaque réponse ciblée est envoyée à <code>claude -p</code> (sans outils, un seul tour) avec <b>uniquement</b> le dialogue qui la précède, rendu en texte neutre (personne / assistant / commande / résultat, modifications en attente incluses) : aucune indication sur l'origine du texte ni sur ce qui a été modifié. Les réponses sont traitées <b>de la plus ancienne à la plus récente</b>, chaque réponse révisée servant de contexte aux suivantes. Rien n'est enregistré tant que tu n'acceptes pas.
        </p>
        <div className="row wrap">
          <label className="opt">
            <input type="radio" checked={scope === 'after_edit'} disabled={firstEditedI == null} onChange={() => setScope('after_edit')} />
            réponses après la première modification{firstEditedI != null ? ` (L${firstEditedI + 1})` : ' — aucune modification en attente'}
          </label>
          <label className="opt">
            <input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} /> toutes les réponses
          </label>
          <label className="opt">
            <input type="radio" checked={scope === 'selected'} disabled={!nSelectedResp} onChange={() => setScope('selected')} /> réponses cochées ({nSelectedResp})
          </label>
        </div>
        <div className="row wrap">
          <label className="opt">
            contexte transmis
            <select value={contextChars} onChange={(e) => setContextChars(Number(e.target.value))}>
              {CONTEXT.map((c) => (
                <option key={c.v} value={c.v}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="opt" title="Inclure les commandes lancées et leurs résultats (tronqués à 4 000 caractères chacun) dans le contexte">
            <input type="checkbox" checked={withTools} onChange={(e) => setWithTools(e.target.checked)} /> avec les appels et résultats d'outils
          </label>
        </div>
        <textarea rows={2} placeholder="Direction optionnelle, ex. : « sois d'accord avec la personne », « reste prudent et mentionne les limites », « conclus que la migration est validée »… (vide = juste rendre cohérent)" value={direction} onChange={(e) => setDirection(e.target.value)} />
        <div className="row">
          <button className="primary" disabled={running || !targets.length} onClick={run}>
            {running ? `Harmonisation… (${done}/${targets.length})` : `Harmoniser ${targets.length} réponse${targets.length > 1 ? 's' : ''}`}
          </button>
          {changed > 0 && (
            <button onClick={acceptAllChanged} disabled={running}>
              Accepter les {changed} réponse{changed > 1 ? 's' : ''} modifiée{changed > 1 ? 's' : ''}
            </button>
          )}
          {cost != null && <span className="hint">coût ≈ {cost.toFixed(3)} $</span>}
          <span className="spacer" />
          <button onClick={onClose}>Fermer</button>
        </div>
        {!targets.length && <div className="hint">Aucune réponse de Claude dans cette portée.</div>}
        {err && <div className="error-box">{err}</div>}
        {props && (
          <div className="proposals">
            {props.map((p, k) => (
              <div key={p.e.i} className={`proposal ${p.status} ${p.accepted ? 'accepted' : ''} ${p.status === 'done' && !p.changed ? 'unchanged' : ''}`}>
                <div className="row">
                  <b>
                    L{p.e.i + 1} · {p.e.title}
                  </b>
                  <span className="dim">tour {p.e.turn}</span>
                  {p.contextMessages != null && <span className="dim">{p.contextMessages} messages de contexte</span>}
                  <span className="spacer" />
                  {p.status === 'pending' && <span className="hint">en attente</span>}
                  {p.status === 'running' && <span className="hint">en cours…</span>}
                  {p.status === 'error' && <span className="badge err">{p.error}</span>}
                  {p.status === 'done' && !p.changed && !p.accepted && <span className="badge">déjà cohérente — inchangée</span>}
                  {p.status === 'done' && !p.accepted && (
                    <button className={p.changed ? 'primary' : ''} onClick={() => accept(k)}>
                      Accepter
                    </button>
                  )}
                  {p.accepted && <span className="badge ok">acceptée → en attente d'enregistrement</span>}
                </div>
                <div className="diff">
                  <div>
                    <div className="hint">Avant</div>
                    <pre className="text">{p.e.text}</pre>
                  </div>
                  <div>
                    <div className="hint">Après</div>
                    {p.status === 'done' ? (
                      <textarea className="after" value={p.text ?? ''} rows={Math.min(20, Math.max(3, (p.text ?? '').split('\n').length + 1))} onChange={(ev) => setProps((old) => (old ?? []).map((x, j) => (j === k ? { ...x, text: ev.target.value, changed: true, accepted: false } : x)))} />
                    ) : (
                      <pre className="text dim">—</pre>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
