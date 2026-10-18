import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CloneResult, Entry, SessionData, Source } from './types';
import { api } from './api';
import { Sidebar } from './components/Sidebar';
import { Toolbar, DEFAULT_KINDS, type Filters } from './components/Toolbar';
import { EntryCard } from './components/EntryCard';
import { RightPanel } from './components/RightPanel';
import { Modal } from './components/Modal';
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
        setF((old) => ({ ...initialFilters, q: old.q, regex: old.regex, caseSensitive: old.caseSensitive, word: old.word, kinds: old.kinds }));
      })
      .catch((e) => notify(`Erreur : ${e.message}`))
      .finally(() => setLoading(false));
  }, [selected]);

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

  const re = useMemo(() => buildRegex(dq, { regex: f.regex, caseSensitive: f.caseSensitive, word: f.word }), [dq, f.regex, f.caseSensitive, f.word]);
  const reTest = useMemo(() => (re ? new RegExp(re.source, re.flags.replace('g', '')) : null), [re]);

  const visible = useMemo(() => {
    if (!data) return [] as Entry[];
    const from = f.from ? new Date(f.from).getTime() : null;
    const to = f.to ? new Date(f.to).getTime() : null;
    return data.entries.filter((e) => {
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
  }, [data, f]);

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
            </div>
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
                  </div>
                  {g.items.map((e) => (
                    <EntryCard key={e.i} e={e} re={re} isCurrent={e.i === currentI} onShowRaw={showRaw} onGoto={onGoto} onFocusTurn={(t) => set({ turn: t })} forceOpen={!!re && matched.includes(e)} />
                  ))}
                </section>
              ))}
            </div>
          </>
        )}
      </main>
      {data && <RightPanel key={data.source.key} data={data} onCloned={onCloned} onDeleted={onDeleted} />}
      {raw && (
        <Modal title={`Ligne ${raw.i + 1} — JSON brut`} onClose={() => setRaw(null)}>
          <pre className="raw">{JSON.stringify(raw.json, null, 2)}</pre>
        </Modal>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
