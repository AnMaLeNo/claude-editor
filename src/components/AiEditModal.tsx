import { useState } from 'react';
import type { AiEditItem, Entry } from '../types';
import { api } from '../api';
import { Modal } from './Modal';

type Proposal = { e: Entry; status: 'pending' | 'done' | 'error'; text?: string; error?: string; accepted?: boolean };

export function AiEditModal({ entries, onClose, onAccept }: { entries: Entry[]; onClose: () => void; onAccept: (e: Entry, text: string) => void }) {
  const [instruction, setInstruction] = useState('');
  const [props, setProps] = useState<Proposal[]>(entries.map((e) => ({ e, status: 'pending' })));
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cost, setCost] = useState<number | null>(null);

  const run = async () => {
    setRunning(true);
    setErr(null);
    setProps(entries.map((e) => ({ e, status: 'pending' })));
    try {
      const { jobId } = await api.aiEdit(
        entries.map((e) => ({ ref: String(e.i), text: e.text })),
        instruction.trim(),
      );
      const res = await api.waitJob<{ items: AiEditItem[] }>(jobId, (p) => {
        const done = new Set((p as { ref: string }[]).map((x) => x.ref));
        setProps((old) => old.map((pr) => (done.has(String(pr.e.i)) && pr.status === 'pending' ? { ...pr, status: 'done', text: '…' } : pr)));
      });
      setProps(
        entries.map((e) => {
          const it = res.items.find((x) => x.ref === String(e.i));
          return it?.ok ? { e, status: 'done', text: it.text, accepted: false } : { e, status: 'error', error: it?.error ?? 'Pas de résultat' };
        }),
      );
      setCost(res.items.reduce((a, it) => a + (it.costUSD ?? 0), 0));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  };
  const accept = (k: number) => {
    const p = props[k];
    if (p.status !== 'done' || p.text == null) return;
    onAccept(p.e, p.text);
    setProps((old) => old.map((x, j) => (j === k ? { ...x, accepted: true } : x)));
  };
  const acceptAll = () => props.forEach((p, k) => p.status === 'done' && !p.accepted && accept(k));
  const ready = props.filter((p) => p.status === 'done').length;

  return (
    <Modal title={`Modifier ${entries.length} entrée${entries.length > 1 ? 's' : ''} avec l'IA`} onClose={onClose}>
      <div className="ai-edit">
        <p className="help">
          Chaque texte est envoyé <b>seul</b> à <code>claude -p</code> avec ton instruction : pas d'outils, un seul tour, et aucune indication sur ce qu'est ce texte (prompt, réponse, résultat d'outil…). Relis chaque proposition avant de l'accepter ; les acceptées deviennent des modifications en attente.
        </p>
        <textarea rows={3} placeholder="Instruction, ex. : « remplace toutes les occurrences de /home/antoine par /home/user », « reformule en anglais sans changer le sens », « supprime les lignes qui mentionnent le mot de passe »…" value={instruction} onChange={(e) => setInstruction(e.target.value)} autoFocus />
        <div className="row">
          <button className="primary" disabled={running || !instruction.trim()} onClick={run}>
            {running ? `Réécriture… (${ready}/${entries.length})` : 'Lancer la réécriture'}
          </button>
          {ready > 0 && (
            <button onClick={acceptAll} disabled={running}>
              Tout accepter ({props.filter((p) => p.status === 'done' && !p.accepted).length})
            </button>
          )}
          {cost != null && <span className="hint">coût ≈ {cost.toFixed(3)} $</span>}
          <span className="spacer" />
          <button onClick={onClose}>Fermer</button>
        </div>
        {err && <div className="error-box">{err}</div>}
        <div className="proposals">
          {props.map((p, k) => (
            <div key={p.e.i} className={`proposal ${p.status} ${p.accepted ? 'accepted' : ''}`}>
              <div className="row">
                <b>
                  L{p.e.i + 1} · {p.e.title}
                </b>
                <span className="dim">tour {p.e.turn}</span>
                <span className="spacer" />
                {p.status === 'pending' && <span className="hint">{running ? 'en cours…' : 'en attente'}</span>}
                {p.status === 'error' && <span className="badge err">{p.error}</span>}
                {p.status === 'done' && !p.accepted && (
                  <button className="primary" onClick={() => accept(k)}>
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
                    <textarea className="after" value={p.text ?? ''} rows={Math.min(20, Math.max(3, (p.text ?? '').split('\n').length + 1))} onChange={(ev) => setProps((old) => old.map((x, j) => (j === k ? { ...x, text: ev.target.value, accepted: false } : x)))} />
                  ) : (
                    <pre className="text dim">—</pre>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
