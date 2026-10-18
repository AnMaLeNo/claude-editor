import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AiSearchResult, CloneResult, EditOp, Entry, SessionData, Source } from './types';
import { api } from './api';
import { Sidebar } from './components/Sidebar';
import { Toolbar, DEFAULT_KINDS, type Filters } from './components/Toolbar';
import { EntryCard } from './components/EntryCard';
import { RightPanel } from './components/RightPanel';
import { Modal } from './components/Modal';
import { ChangesBar } from './components/ChangesBar';
import { AiSearchPanel } from './components/AiSearchPanel';
import { AiEditModal } from './components/AiEditModal';
import { SettingsModal } from './components/SettingsModal';
import { buildRegex } from './highlight';

const initialFilters: Filters = {
  q: '',
  regex: false,
  caseSensitive: false,
  word: false,
  kinds: new Set(DEFAULT_KINDS),
  tools: new Set(),
  errorsOnly: false,
  includeSidechain: false,
  from: '',
  to: '',
  turn: null,
};

function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export default function App() {
  const [sessions, setSessions] = useState<Source[]>([]);
  const [selected, setSelected] = useState<string | undefined>();
  const [data, setData] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [f, setF] = useState<Filters>(initialFilters);
  const [raw, setRaw] = useState<{ i: number; json: unknown } | null>(null);
  const [current, setCurrent] = useState(0);
  const [config, setConfig] = useState<{ projectsDir: string; dataDir: string } | null>(null);
  const [ops, setOps] = useState<EditOp[]>([]);
  const [reloadTick, setReloadTick] = useState(0);
  const [mode, setMode] = useState<'text' | 'ai'>('text');
  const [aiResult, setAiResult] = useState<AiSearchResult | null>(null);
  const [aiRunning, setAiRunning] = useState(false);
  const [aiProgress, setAiProgress] = useState('');
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [aiEditOpen, setAiEditOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const set = useCallback((p: Partial<Filters>) => setF((old) => ({ ...old, ...p })), []);
  const dq = useDebounced(f.q, 150);

  const notify = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 6000);
  };

  const refresh = useCallback(async () => {
    try {
      const r = await api.sessions();
      setSessions(r.sessions);
    } catch (e) {
      notify(`Erreur : ${(e as Error).message}`);
    }
  }, []);

  useEffect(() => {
    refresh();
    api.config().then(setConfig).catch(() => {});
  }, [refresh]);

  useEffect(() => {
    if (!selected) return;
    setLoading(true);
    setData(null);
    api
      .session(selected)
      .then((d) => {
        setData(d);
        setOps([]);
        setAiResult(null);
        setSelection(new Set());
        setF((old) => ({ ...initialFilters, q: old.q, regex: old.regex, caseSensitive: old.caseSensitive, word: old.word, kinds: old.kinds }));
      })
      .catch((e) => notify(`Erreur : ${e.message}`))
      .finally(() => setLoading(false));
  }, [selected, reloadTick]);

  const onUpload = async (file: File) => {
    setLoading(true);
    try {
      const r = await api.upload(file);
      await refresh();
      setSelected(r.source.key);
      if (r.parseErrors) notify(`Fichier ouvert, mais ${r.parseErrors} ligne(s) illisible(s)${r.truncated ? ' — la dernière ligne semble tronquée.' : '.'}`);
    } catch (e) {
      notify(`Import impossible : ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  // Entrées affichées = fichier d'origine + modifications en attente (aperçu local, rien n'est écrit).
  const entries = useMemo(() => {
    if (!data) return [] as Entry[];
    if (!ops.length) return data.entries;
    const edits = new Map<number, string>();
    const deleted = new Set<number>();
    const inserts = new Map<number, Extract<EditOp, { op: 'insert_after' }>[]>();
    for (const o of ops) {
      if (o.op === 'set_text') edits.set(o.i, o.text);
      else if (o.op === 'delete') deleted.add(o.i);
      else {
        if (!inserts.has(o.i)) inserts.set(o.i, []);
        inserts.get(o.i)!.push(o);
      }
    }
    // cascade appel <-> résultat (comme le serveur)
    for (const e of data.entries) {
      if (e.kind === 'tool_result' && e.tools?.some((t) => t.useIndex != null && deleted.has(t.useIndex))) deleted.add(e.i);
    }
    for (const e of data.entries) {
      if (e.kind === 'tool_result' && deleted.has(e.i)) for (const t of e.tools ?? []) if (t.useIndex != null) deleted.add(t.useIndex);
    }
    const out: Entry[] = [];
    for (const e of data.entries) {
      let x = e;
      if (edits.has(e.i)) x = { ...x, text: edits.get(e.i)!, edited: true };
      if (deleted.has(e.i)) x = { ...x, deleted: true };
      out.push(x);
      for (const ins of inserts.get(e.i) ?? []) {
        out.push({
          i: -1,
          bytes: 0,
          type: ins.role,
          kind: ins.role === 'user' ? 'prompt' : 'assistant',
          parentUuid: null,
          ts: e.ts,
          sidechain: false,
          turn: e.turn,
          title: ins.role === 'user' ? 'Nouveau prompt (inséré)' : 'Nouvelle réponse (insérée)',
          text: ins.text,
          heavy: false,
          inserted: true,
          insertId: ins.id,
        });
      }
    }
    return out;
  }, [data, ops]);

  const onEdit = (e: Entry, text: string) => {
    if (e.inserted) setOps((o) => o.map((x) => (x.op === 'insert_after' && x.id === e.insertId ? { ...x, text } : x)));
    else setOps((o) => [...o.filter((x) => !(x.op === 'set_text' && x.i === e.i)), { op: 'set_text', i: e.i, text }]);
  };
  const onDelete = (e: Entry) => {
    if (e.inserted) setOps((o) => o.filter((x) => !(x.op === 'insert_after' && x.id === e.insertId)));
    else setOps((o) => [...o.filter((x) => !(x.op === 'delete' && x.i === e.i)), { op: 'delete', i: e.i }]);
  };
  const onRestore = (e: Entry) => {
    if (!data) return;
    // rétablir aussi la paire appel/résultat
    const pair = new Set<number>([e.i]);
    if (e.kind === 'tool_result') for (const t of e.tools ?? []) if (t.useIndex != null) pair.add(t.useIndex);
    if (e.kind === 'tool_use') for (const r of data.entries) if (r.kind === 'tool_result' && r.tools?.some((t) => t.useIndex === e.i)) pair.add(r.i);
    setOps((o) => o.filter((x) => !(x.op === 'delete' && pair.has(x.i))));
  };
  const onInsert = (e: Entry, role: 'user' | 'assistant') => {
    const text = role === 'user' ? 'Nouveau message utilisateur…' : 'Nouvelle réponse de Claude…';
    setOps((o) => [...o, { op: 'insert_after', i: e.i, role, text, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }]);
  };
  const deleteTurn = (turn: number) => {
    if (!data) return;
    const targets = data.entries.filter((x) => x.turn === turn && ['prompt', 'assistant', 'thinking', 'tool_use', 'tool_result'].includes(x.kind));
    if (!targets.length) return;
    if (!confirm(`Supprimer les ${targets.length} entrées conversationnelles du tour ${turn} ?`)) return;
    setOps((o) => [...o.filter((x) => !(x.op === 'delete' && targets.some((t) => t.i === x.i))), ...targets.map((t) => ({ op: 'delete', i: t.i }) as EditOp)]);
  };
  const saveEdits = async (dest: 'inplace' | 'clone', title?: string) => {
    if (!data || !selected) return;
    setSaving(true);
    try {
      const r = await api.edit(selected, { ops, dest, title, cloneDest: 'same' });
      await refresh();
      setOps([]);
      if (r.source.key !== selected) setSelected(r.source.key);
      else setReloadTick((t) => t + 1);
      notify(dest === 'clone' ? `Modifications enregistrées dans un nouveau clone : ${r.resumeById ?? r.resumeByPath}` : `Fichier enregistré (${r.deleted} suppression(s), ${r.inserted} insertion(s)).`);
    } catch (e) {
      notify(`Enregistrement impossible : ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const runAiSearch = async (q: string, includeMeta: boolean, scope: string, type: string) => {
    if (!selected) return;
    setAiRunning(true);
    setAiProgress('');
    try {
      const { jobId } = await api.aiSearch(selected, q, includeMeta, scope, type);
      const r = await api.waitJob<AiSearchResult>(jobId, (p) => {
        const last = p[p.length - 1] as { batch: number; batches: number; entries: number; total: number } | undefined;
        if (last) setAiProgress(`lot ${last.batch}/${last.batches} · ${last.entries}/${last.total} entrées analysées`);
      });
      setAiResult(r);
    } catch (e) {
      notify(`Recherche IA impossible : ${(e as Error).message}`);
    } finally {
      setAiRunning(false);
    }
  };
  const toggleSelect = (i: number) =>
    setSelection((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  const selectedEntries = useMemo(() => (data ? data.entries.filter((e) => selection.has(e.i)) : []), [data, selection]);

  const re = useMemo(() => buildRegex(dq, { regex: f.regex, caseSensitive: f.caseSensitive, word: f.word }), [dq, f.regex, f.caseSensitive, f.word]);
  const reTest = useMemo(() => (re ? new RegExp(re.source, re.flags.replace('g', '')) : null), [re]);

  const visible = useMemo(() => {
    if (!data) return [] as Entry[];
    const from = f.from ? new Date(f.from).getTime() : null;
    const to = f.to ? new Date(f.to).getTime() : null;
    return entries.filter((e) => {
      if (!f.kinds.has(e.kind)) return false;
      if (!f.includeSidechain && e.sidechain) return false;
      if (f.errorsOnly && !e.isError && !(e.kind === 'system' && (e.level === 'error' || /error/i.test(e.subtype ?? '')))) return false;
      if (f.tools.size && !(e.tools?.some((t) => f.tools.has(t.name)))) return false;
      if (f.turn != null && e.turn !== f.turn) return false;
      if ((from || to) && e.ts) {
        const t = new Date(e.ts).getTime();
        if (from && t < from) return false;
        if (to && t > to) return false;
      }
      return true;
    });
  }, [data, entries, f]);

  const matched = useMemo(() => {
    if (!reTest) return visible;
    return visible.filter((e) => reTest.test(e.text) || (!!e.thinking && reTest.test(e.thinking)) || reTest.test(e.title));
  }, [visible, reTest]);

  const shownList = re ? matched : visible;

  useEffect(() => setCurrent(0), [re, visible]);

  const scrollTo = (i: number) => {
    document.getElementById(`e-${i}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const go = (delta: number) => {
    if (!matched.length) return;
    const n = (current + delta + matched.length) % matched.length;
    setCurrent(n);
    scrollTo(matched[n].i);
  };
  useEffect(() => {
    if (re && matched.length) scrollTo(matched[Math.min(current, matched.length - 1)].i);
  }, [re, matched]); // eslint-disable-line react-hooks/exhaustive-deps

  const pendingGoto = useRef<number | null>(null);
  const onGoto = (target: string | number) => {
    if (!data) return;
    let e: Entry | undefined;
    if (typeof target === 'number') e = data.entries.find((x) => x.i === target);
    else if (target.startsWith('result:')) {
      const i = Number(target.slice(7));
      e = data.entries.find((x) => x.kind === 'tool_result' && x.tools?.some((t) => t.useIndex === i));
    } else e = data.entries.find((x) => x.uuid === target);
    if (!e) return notify('Entrée introuvable dans ce fichier.');
    const needKind = !f.kinds.has(e.kind);
    const needSide = e.sidechain && !f.includeSidechain;
    const needTurn = f.turn != null && f.turn !== e.turn;
    if (needKind || needSide || needTurn) {
      const kinds = new Set(f.kinds);
      kinds.add(e.kind);
      set({ kinds, includeSidechain: f.includeSidechain || e.sidechain, turn: needTurn ? null : f.turn, tools: new Set(), errorsOnly: false });
      pendingGoto.current = e.i;
    } else scrollTo(e.i);
    flash(e.i);
  };
  useEffect(() => {
    if (pendingGoto.current != null) {
      const i = pendingGoto.current;
      pendingGoto.current = null;
      setTimeout(() => scrollTo(i), 50);
    }
  }, [visible]);
  const flash = (i: number) => {
    setTimeout(() => {
      const el = document.getElementById(`e-${i}`);
      el?.classList.add('flash');
      setTimeout(() => el?.classList.remove('flash'), 1500);
    }, 120);
  };

  const showRaw = async (i: number) => {
    if (!selected) return;
    if (i < 0) return notify("Entrée insérée : elle n'existe pas encore dans le fichier.");
    try {
      setRaw({ i, json: await api.line(selected, i) });
    } catch (e) {
      notify(`Erreur : ${(e as Error).message}`);
    }
  };

  const onCloned = async (r: CloneResult) => {
    await refresh();
    notify(`Clone créé : ${r.newSessionId}`);
  };
  const onDeleted = async () => {
    setSelected(undefined);
    setData(null);
    await refresh();
  };

  // regroupement par tour
  const groups = useMemo(() => {
    const out: { turn: number; prompt?: Entry; items: Entry[] }[] = [];
    for (const e of shownList) {
      let g = out[out.length - 1];
      if (!g || g.turn !== e.turn) {
        g = { turn: e.turn, prompt: data?.entries.find((x) => x.kind === 'prompt' && x.turn === e.turn && !x.sidechain), items: [] };
        out.push(g);
      }
      g.items.push(e);
    }
    return out;
  }, [shownList, data]);

  const currentI = re && matched.length ? matched[Math.min(current, matched.length - 1)].i : -1;

  return (
    <div className="app">
      <Sidebar sessions={sessions} selected={selected} onSelect={setSelected} onUpload={onUpload} onRefresh={refresh} busy={loading} />
      <main className="main">
        {!data && !loading && (
          <div className="welcome">
            <h2>Explorateur de conversations Claude Code</h2>
            <p>
              Choisis une session à gauche, ou dépose un fichier <code>.jsonl</code>. Les transcripts locaux sont lus dans <code>{config?.projectsDir ?? '~/.claude/projects'}</code> ; les fichiers déposés et les clones vivent dans <code>{config?.dataDir ?? './data'}</code>.
            </p>
            <ol>
              <li>Filtre par type (prompts, réponses, outils…), par outil, par tour, par date, erreurs seulement.</li>
              <li>Recherche plein texte avec navigation Entrée / Maj+Entrée, regex et casse en option.</li>
              <li>Clone une session pour la continuer avec <code>claude --resume</code> sans toucher l'original.</li>
            </ol>
          </div>
        )}
        {loading && <div className="welcome">Chargement…</div>}
        {data && (
          <>
            <div className="session-head">
              <h2 title={data.stats.firstPrompt}>{data.stats.title ?? data.stats.firstPrompt ?? data.source.fileName}</h2>
              <span className="dim mono">{data.stats.sessionId}</span>
              <span className="spacer" />
              <span className="mode-switch" title="Recherche texte (locale) ou recherche IA (JEV)">
                <button className={mode === 'text' ? 'on' : ''} onClick={() => setMode('text')}>
                  Recherche texte
                </button>
                <button className={mode === 'ai' ? 'on' : ''} onClick={() => setMode('ai')}>
                  Recherche IA
                </button>
              </span>
              {selection.size > 0 && (
                <span className="sel-bar">
                  <b>{selection.size}</b> cochée{selection.size > 1 ? 's' : ''}
                  <button className="primary" onClick={() => setAiEditOpen(true)}>
                    Modifier avec l'IA
                  </button>
                  <button onClick={() => setSelection(new Set())}>✕</button>
                </span>
              )}
              <button onClick={() => setSettingsOpen(true)} title="Paramètres IA (JEV, claude -p)">
                ⚙ IA
              </button>
            </div>
            {mode === 'ai' && (
              <div className="toolbar">
                <AiSearchPanel
                  result={aiResult}
                  entries={entries}
                  running={aiRunning}
                  progress={aiProgress}
                  onRun={runAiSearch}
                  onGoto={(i) => onGoto(i)}
                  selected={selection}
                  onToggle={toggleSelect}
                  onSelectAll={(is) => setSelection(new Set([...selection, ...is.filter((i) => ['prompt', 'assistant', 'tool_result'].includes(data.entries.find((e) => e.i === i)?.kind ?? ''))]))}
                  onEditSelection={() => setAiEditOpen(true)}
                />
              </div>
            )}
            <Toolbar f={f} set={set} stats={data.stats} matches={matched.length} shown={visible.length} total={data.entries.length} onPrev={() => go(-1)} onNext={() => go(1)} current={Math.min(current, Math.max(0, matched.length - 1))} />
            <div className="timeline">
              {shownList.length === 0 && <div className="empty">Rien à afficher avec ces filtres.</div>}
              {groups.map((g, gi) => (
                <section key={`${g.turn}-${gi}`} className="turn">
                  <div className="turn-head">
                    <button className="link" onClick={() => set({ turn: f.turn === g.turn ? null : g.turn })} title="Isoler ce tour">
                      Tour {g.turn}
                    </button>
                    {g.turn === 0 && <span className="dim">avant le premier prompt</span>}
                    {g.prompt && <span className="turn-prompt">{g.prompt.text.replace(/<(ide_selection|system-reminder|ide_opened_file)>[\s\S]*?<\/\1>/g, '').trim().slice(0, 140)}</span>}
                    {g.prompt?.ts && <span className="dim">{new Date(g.prompt.ts).toLocaleString('fr-FR')}</span>}
                    <span className="dim">{g.items.length} entrée{g.items.length > 1 ? 's' : ''}</span>
                    {g.turn > 0 && (
                      <button className="link danger-link" onClick={() => deleteTurn(g.turn)} title="Marquer tout le tour à supprimer (prompt, réponses, outils)">
                        ✕ tour
                      </button>
                    )}
                  </div>
                  {g.items.map((e) => (
                    <EntryCard key={e.inserted ? `ins-${e.insertId}` : e.i} e={e} re={re} isCurrent={e.i === currentI} onShowRaw={showRaw} onGoto={onGoto} onFocusTurn={(t) => set({ turn: t })} forceOpen={!!re && matched.includes(e)} onEdit={onEdit} onDelete={onDelete} onRestore={onRestore} onInsert={onInsert} selected={selection.has(e.i)} onToggleSelect={toggleSelect} />
                  ))}
                </section>
              ))}
            </div>
            {ops.length > 0 && <ChangesBar ops={ops} source={data.source} onSave={saveEdits} onCancel={() => setOps([])} busy={saving} />}
          </>
        )}
      </main>
      {data && <RightPanel key={data.source.key} data={data} onCloned={onCloned} onDeleted={onDeleted} />}
      {raw && (
        <Modal title={`Ligne ${raw.i + 1} — JSON brut`} onClose={() => setRaw(null)}>
          <pre className="raw">{JSON.stringify(raw.json, null, 2)}</pre>
        </Modal>
      )}
      {aiEditOpen && selectedEntries.length > 0 && (
        <AiEditModal
          entries={selectedEntries}
          onClose={() => setAiEditOpen(false)}
          onAccept={(e, text) => onEdit(e, text)}
        />
      )}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
