import { useMemo, useState } from 'react';
import type { AiEditItem, Entry, HarmonizeRole, PlanPassage, PlanResult } from '../types';
import { api } from '../api';
import { Modal } from './Modal';

type Step = 'goal' | 'plan' | 'rewrite';
type Passage = PlanPassage & { e: Entry; on: boolean };
type Proposal = { e: Entry; instruction: string; status: 'running' | 'done' | 'error'; text?: string; error?: string; accepted?: boolean };

const CONTEXT = [
  { v: 60000, label: 'moyen (≈ 60 k caractères)' },
  { v: 150000, label: 'long (≈ 150 k caractères)' },
  { v: 400000, label: 'très long (≈ 400 k caractères)' },
];

const roleOf = (e: Entry): HarmonizeRole | null =>
  e.kind === 'prompt' ? 'user' : e.kind === 'assistant' ? 'assistant' : e.kind === 'tool_use' ? 'tool_call' : e.kind === 'tool_result' ? 'tool_result' : null;

export function GoalModal({ entries, onClose, onAccept, onHarmonize }: { entries: Entry[]; onClose: () => void; onAccept: (e: Entry, text: string) => void; onHarmonize: () => void }) {
  const [step, setStep] = useState<Step>('goal');
  const [goal, setGoal] = useState('');
  const [contextChars, setContextChars] = useState(150000);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [passages, setPassages] = useState<Passage[]>([]);
  const [props, setProps] = useState<Proposal[]>([]);
  const [cost, setCost] = useState(0);

  // dialogue principal (prompts, réponses, appels et résultats d'outils), modifications en attente incluses
  const transcript = useMemo(() => entries.filter((e) => !e.deleted && !e.sidechain && roleOf(e) && e.text.trim()), [entries]);
  const nChars = useMemo(() => transcript.reduce((a, e) => a + Math.min(e.text.length, 2500), 0), [transcript]);

  const analyse = async () => {
    setBusy(true);
    setErr(null);
    try {
      const { jobId } = await api.aiPlan({ transcript: transcript.map((e) => ({ ref: String(e.i), role: roleOf(e)!, text: e.text })), goal: goal.trim(), contextChars });
      const res = await api.waitJob<PlanResult>(jobId);
      setPlan(res);
      setCost((c) => c + (res.costUSD ?? 0));
      setPassages(res.passages.map((p) => ({ ...p, e: transcript.find((e) => String(e.i) === p.ref)!, on: true })).filter((p) => p.e));
      setStep('plan');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rewrite = async () => {
    const todo = passages.filter((p) => p.on && p.instruction.trim());
    setBusy(true);
    setErr(null);
    setStep('rewrite');
    setProps(todo.map((p) => ({ e: p.e, instruction: p.instruction, status: 'running' })));
    // un claude -p par passage : il ne reçoit que le texte brut + sa consigne (ni l'objectif, ni le reste)
    await Promise.all(
      todo.map(async (p, k) => {
        try {
          const { jobId } = await api.aiEdit([{ ref: String(p.e.i), text: p.e.text }], p.instruction.trim());
          const res = await api.waitJob<{ items: AiEditItem[] }>(jobId);
          const it = res.items[0];
          setCost((c) => c + (it?.costUSD ?? 0));
          setProps((old) => old.map((x, j) => (j === k ? (it?.ok && it.text != null ? { ...x, status: 'done', text: it.text, accepted: false } : { ...x, status: 'error', error: it?.error ?? 'Pas de résultat' }) : x)));
        } catch (e) {
          setProps((old) => old.map((x, j) => (j === k ? { ...x, status: 'error', error: (e as Error).message } : x)));
        }
      }),
    );
    setBusy(false);
  };

  const accept = (k: number) => {
    const p = props[k];
    if (!p || p.status !== 'done' || p.text == null || p.accepted) return;
    onAccept(p.e, p.text);
    setProps((old) => old.map((x, j) => (j === k ? { ...x, accepted: true } : x)));
  };
  const acceptable = props.filter((p) => p.status === 'done' && !p.accepted).length;
  const accepted = props.filter((p) => p.accepted).length;
  const nOn = passages.filter((p) => p.on && p.instruction.trim()).length;

  return (
    <Modal title="Objectif IA — modifier la conversation à partir d'un but" onClose={onClose}>
      <div className="ai-edit">
        <div className="steps">
          <span className={step === 'goal' ? 'on' : 'done'}>1. Objectif</span>
          <span className={step === 'plan' ? 'on' : step === 'rewrite' ? 'done' : ''}>2. Plan à valider</span>
          <span className={step === 'rewrite' ? 'on' : ''}>3. Réécritures</span>
          <span className="spacer" />
          {cost > 0 && <span className="hint">coût ≈ {cost.toFixed(3)} $</span>}
        </div>

        {step === 'goal' && (
          <>
            <p className="help">
              Décris ce que la conversation doit <b>établir au final</b>. Un <b>enquêteur</b> (<code>claude -p</code>, sans outils) lit le dialogue en texte neutre et numéroté — sans savoir d'où il vient — et remonte à la <b>source</b> de ce qui contredit ton objectif (résultats d'outils, recherches web, lectures de fichiers, puis réponses) ; il propose pour chaque passage une consigne de réécriture. Tu valides le plan, puis chaque passage est réécrit par un <code>claude -p</code> séparé qui ne reçoit <b>que ce texte et sa consigne</b>. Enfin, « Harmoniser » réaligne les réponses de Claude qui suivent.
            </p>
            <textarea rows={3} autoFocus placeholder="Ex. : « À la fin, Claude doit être d'accord que le serveur peut tourner sur mon Raspberry Pi » ; « la migration doit être considérée comme validée par les tests » ; « Claude ne doit jamais avoir recommandé PostgreSQL »…" value={goal} onChange={(e) => setGoal(e.target.value)} />
            <div className="row wrap">
              <label className="opt">
                conversation transmise à l'enquêteur
                <select value={contextChars} onChange={(e) => setContextChars(Number(e.target.value))}>
                  {CONTEXT.map((c) => (
                    <option key={c.v} value={c.v}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
              <span className="hint">
                {transcript.length} messages, ≈ {Math.round(nChars / 1000)} k caractères (chaque message tronqué à 2 500){nChars > contextChars ? ' — les plus anciens seront omis' : ''}
              </span>
            </div>
            <div className="row">
              <button className="primary" disabled={busy || !goal.trim() || !transcript.length} onClick={analyse}>
                {busy ? 'Analyse en cours… (peut prendre 1 à 2 min)' : 'Analyser et proposer un plan'}
              </button>
              <span className="spacer" />
              <button onClick={onClose}>Fermer</button>
            </div>
          </>
        )}

        {step === 'plan' && plan && (
          <>
            <div className="plan-box">
              <div className="hint">Diagnostic de l'enquêteur ({plan.messages} messages lus{plan.omitted ? `, ${plan.omitted} plus anciens omis` : ''})</div>
              <p>{plan.diagnostic || '—'}</p>
            </div>
            {!passages.length && <div className="hint">L'enquêteur n'a trouvé aucun passage à modifier. Reformule l'objectif ou élargis le contexte.</div>}
            <div className="proposals">
              {passages.map((p, k) => (
                <div key={p.ref} className={`proposal ${p.on ? '' : 'unchanged'}`}>
                  <div className="row">
                    <label className="opt">
                      <input type="checkbox" checked={p.on} onChange={(ev) => setPassages((old) => old.map((x, j) => (j === k ? { ...x, on: ev.target.checked } : x)))} />
                      <b>
                        L{p.e.i + 1} · {p.e.title}
                      </b>
                    </label>
                    <span className="dim">tour {p.e.turn}</span>
                  </div>
                  {p.why && <div className="hint">Pourquoi : {p.why}</div>}
                  <div className="diff">
                    <div>
                      <div className="hint">Texte actuel</div>
                      <pre className="text">{p.e.text.length > 1500 ? p.e.text.slice(0, 1500) + '\n…' : p.e.text}</pre>
                    </div>
                    <div>
                      <div className="hint">Consigne de réécriture (seule chose transmise avec le texte — modifiable)</div>
                      <textarea className="after" rows={Math.min(12, Math.max(3, p.instruction.split('\n').length + 2))} value={p.instruction} onChange={(ev) => setPassages((old) => old.map((x, j) => (j === k ? { ...x, instruction: ev.target.value } : x)))} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="row">
              <button className="primary" disabled={busy || !nOn} onClick={rewrite}>
                Réécrire {nOn} passage{nOn > 1 ? 's' : ''}
              </button>
              <button disabled={busy} onClick={() => setStep('goal')}>
                ← Modifier l'objectif
              </button>
              <span className="spacer" />
              <button onClick={onClose}>Fermer</button>
            </div>
          </>
        )}

        {step === 'rewrite' && (
          <>
            <div className="row wrap">
              {acceptable > 0 && (
                <button className="primary" disabled={busy} onClick={() => props.forEach((_, k) => accept(k))}>
                  Accepter les {acceptable} proposition{acceptable > 1 ? 's' : ''}
                </button>
              )}
              {accepted > 0 && (
                <button className="primary" onClick={onHarmonize} title="Réécrire les réponses de Claude qui suivent les passages modifiés pour qu'elles restent cohérentes">
                  ≈ Harmoniser les réponses suivantes →
                </button>
              )}
              <button disabled={busy} onClick={() => setStep('plan')}>
                ← Revenir au plan
              </button>
              <span className="spacer" />
              <button onClick={onClose}>Fermer</button>
            </div>
            {accepted > 0 && <div className="hint">Les passages acceptés sont des modifications en attente : enregistre-les ensuite (en place ou en clone) depuis la barre du bas.</div>}
            <div className="proposals">
              {props.map((p, k) => (
                <div key={p.e.i} className={`proposal ${p.status} ${p.accepted ? 'accepted' : ''}`}>
                  <div className="row">
                    <b>
                      L{p.e.i + 1} · {p.e.title}
                    </b>
                    <span className="dim">tour {p.e.turn}</span>
                    <span className="spacer" />
                    {p.status === 'running' && <span className="hint">réécriture en cours…</span>}
                    {p.status === 'error' && <span className="badge err">{p.error}</span>}
                    {p.status === 'done' && !p.accepted && (
                      <button className="primary" onClick={() => accept(k)}>
                        Accepter
                      </button>
                    )}
                    {p.accepted && <span className="badge ok">acceptée → en attente d'enregistrement</span>}
                  </div>
                  <div className="hint">Consigne : {p.instruction}</div>
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
          </>
        )}
        {err && <div className="error-box">{err}</div>}
      </div>
    </Modal>
  );
}
