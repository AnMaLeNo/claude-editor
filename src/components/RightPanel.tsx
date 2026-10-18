import { useState } from 'react';
import type { CloneResult, SessionData, Kind } from '../types';
import { KIND_INFO } from '../types';
import { api } from '../api';

function n(x?: number) {
  return (x ?? 0).toLocaleString('fr-FR');
}
function dur(ms?: number) {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

export function RightPanel({ data, onCloned, onDeleted }: { data: SessionData; onCloned: (r: CloneResult) => void; onDeleted: () => void }) {
  const { source, stats } = data;
  const [title, setTitle] = useState('');
  const [dest, setDest] = useState<'same' | 'workspace'>(source.group === 'local' ? 'same' : 'workspace');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<CloneResult | null>(null);
  const [tab, setTab] = useState<'stats' | 'actions' | 'guide'>('actions');

  const clone = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.clone(source.key, { dest, title });
      setResult(r);
      onCloned(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm(`Supprimer ${source.fileName} ?`)) return;
    try {
      await api.remove(source.key);
      onDeleted();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const span = stats.first && stats.last ? new Date(stats.last).getTime() - new Date(stats.first).getTime() : undefined;

  return (
    <aside className="right">
      <div className="tabs">
        {(['actions', 'stats', 'guide'] as const).map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t === 'actions' ? 'Actions' : t === 'stats' ? 'Statistiques' : 'Guide'}
          </button>
        ))}
      </div>

      {tab === 'actions' && (
        <div className="panel">
          <h3>Session</h3>
          <dl>
            <dt>sessionId</dt>
            <dd className="mono">{stats.sessionId ?? '—'}</dd>
            <dt>Fichier</dt>
            <dd className="mono small">{source.path}</dd>
            {stats.forkedFrom && (
              <>
                <dt>Clonée depuis</dt>
                <dd className="mono">{stats.forkedFrom}</dd>
              </>
            )}
            {source.idMismatch && (
              <>
                <dt>⚠</dt>
                <dd>Le nom du fichier ({source.fileId}) ne correspond pas au sessionId : Claude Code attend <code>&lt;sessionId&gt;.jsonl</code>.</dd>
              </>
            )}
          </dl>

          <h3>Cloner pour continuer</h3>
          <p className="help">
            Crée une copie avec un <b>nouveau sessionId</b> (même mécanisme que <code>/branch</code>) : l'original n'est pas touché, et le clone se reprend avec <code>claude --resume</code>.
          </p>
          <input placeholder="Titre du clone (optionnel)" value={title} onChange={(e) => setTitle(e.target.value)} />
          <label className="opt">
            <input type="radio" checked={dest === 'same'} onChange={() => setDest('same')} disabled={source.group !== 'local'} />
            <span>
              à côté de l'original (dans ~/.claude/projects) → <code>claude --resume &lt;id&gt;</code> depuis le même dossier
            </span>
          </label>
          <label className="opt">
            <input type="radio" checked={dest === 'workspace'} onChange={() => setDest('workspace')} />
            <span>
              dans l'espace de travail de l'app → télécharger puis <code>claude --resume &lt;chemin&gt;</code>
            </span>
          </label>
          <button className="primary" onClick={clone} disabled={busy}>
            {busy ? 'Clonage…' : 'Cloner cette session'}
          </button>
          {err && <div className="error-box">{err}</div>}
          {result && (
            <div className="result-box">
              <b>Clone créé</b>
              <div className="mono small">{result.source.path}</div>
              <p className="help">Pour le continuer :</p>
              {result.resumeById && <code className="cmd">{result.resumeById}</code>}
              <code className="cmd">{result.resumeByPath}</code>
              <p className="help">
                Si tu lances Claude Code sur une autre machine, télécharge le fichier et place-le dans <code>~/.claude/projects/&lt;dossier-du-projet&gt;/</code> en gardant son nom, ou passe son chemin absolu à <code>--resume</code>.
              </p>
              <a className="button" href={api.downloadUrl(result.source.key)}>
                Télécharger le clone
              </a>
            </div>
          )}

          <h3>Fichier</h3>
          <div className="row">
            <a className="button" href={api.downloadUrl(source.key)}>
              Télécharger ce .jsonl
            </a>
            {source.writable && (
              <button className="danger" onClick={remove}>
                Supprimer
              </button>
            )}
          </div>
          {!source.writable && <p className="help">Session locale de Claude Code : lecture seule. Clone-la pour la modifier.</p>}
          {data.parseErrors.length > 0 && (
            <div className="error-box">
              {data.parseErrors.length} ligne(s) illisible(s) (JSON invalide) — ligne {data.parseErrors[0].i + 1} : {data.parseErrors[0].message}. Fichier tronqué ?
            </div>
          )}
        </div>
      )}

      {tab === 'stats' && (
        <div className="panel">
          <h3>Vue d'ensemble</h3>
          <dl>
            <dt>Tours</dt>
            <dd>{n(stats.turns)}</dd>
            <dt>Lignes</dt>
            <dd>
              {n(stats.lines)} · {(stats.bytes / 1024).toFixed(0)} Ko
            </dd>
            <dt>Début</dt>
            <dd>{stats.first ? new Date(stats.first).toLocaleString('fr-FR') : '—'}</dd>
            <dt>Fin</dt>
            <dd>{stats.last ? new Date(stats.last).toLocaleString('fr-FR') : '—'}</dd>
            <dt>Étendue</dt>
            <dd>{dur(span)}</dd>
            <dt>Compactions</dt>
            <dd>{stats.compactions}</dd>
            <dt>Erreurs d'outils</dt>
            <dd>{stats.errors}</dd>
            <dt>Lignes sous-agents</dt>
            <dd>{stats.sidechain}</dd>
            <dt>Modèle(s)</dt>
            <dd>{stats.models.join(', ') || '—'}</dd>
            <dt>Claude Code</dt>
            <dd>
              v{stats.version ?? '?'} · {stats.entrypoint ?? '?'}
            </dd>
            <dt>Dossier</dt>
            <dd className="mono small">{stats.cwd ?? '—'}</dd>
            <dt>Branche git</dt>
            <dd>{stats.gitBranch ?? '—'}</dd>
          </dl>
          <h3>Tokens (appels API dédupliqués : {stats.usage.apiCalls})</h3>
          <dl>
            <dt>Entrée</dt>
            <dd>{n(stats.usage.input)}</dd>
            <dt>Cache lu</dt>
            <dd>{n(stats.usage.cacheRead)}</dd>
            <dt>Cache écrit</dt>
            <dd>{n(stats.usage.cacheWrite)}</dd>
            <dt>Sortie</dt>
            <dd>
              {n(stats.usage.output)} (dont réflexion {n(stats.usage.thinking)})
            </dd>
            {stats.cost && (
              <>
                <dt>Coût estimé</dt>
                <dd>{stats.cost.totalCostUSD != null ? `${stats.cost.totalCostUSD.toFixed(3)} $` : '—'}</dd>
                <dt>Lignes de code</dt>
                <dd>
                  +{n(stats.cost.linesAdded)} / −{n(stats.cost.linesRemoved)}
                </dd>
              </>
            )}
          </dl>
          <h3>Par type</h3>
          <dl>
            {(Object.keys(KIND_INFO) as Kind[]).map((k) => (
              <div key={k} className="kv">
                <dt>
                  <span className="dot" style={{ background: KIND_INFO[k].color }} /> {KIND_INFO[k].label}
                </dt>
                <dd>{n(stats.byKind[k])}</dd>
              </div>
            ))}
          </dl>
          <h3>Outils</h3>
          <dl>
            {Object.entries(stats.tools)
              .sort((a, b) => b[1] - a[1])
              .map(([t, c]) => (
                <div key={t} className="kv">
                  <dt>{t}</dt>
                  <dd>{c}</dd>
                </div>
              ))}
          </dl>
        </div>
      )}

      {tab === 'guide' && (
        <div className="panel">
          <h3>Comment lire un transcript</h3>
          <p className="help">
            Chaque ligne du .jsonl est une entrée. Les entrées <b>user</b>/<b>assistant</b> sont chaînées par <code>parentUuid</code> ; Claude Code reconstruit la conversation en remontant cette chaîne depuis la dernière ligne. Un <b>tour</b> commence à chaque prompt que tu envoies.
          </p>
          {(Object.keys(KIND_INFO) as Kind[]).map((k) => (
            <div key={k} className="guide-item">
              <span className="dot" style={{ background: KIND_INFO[k].color }} />
              <div>
                <b>{KIND_INFO[k].label}</b>
                <div className="help">{KIND_INFO[k].help}</div>
              </div>
            </div>
          ))}
          <h3>Recherche</h3>
          <ul className="help">
            <li>La recherche porte sur le texte des entrées affichées (filtres actifs). Entrée / Maj+Entrée pour naviguer.</li>
            <li><code>.*</code> active les expressions régulières, <code>Aa</code> la casse, <code>⌶mot⌶</code> le mot entier.</li>
            <li>Les puces d'outils filtrent appels <i>et</i> résultats de l'outil.</li>
            <li>« tour N » sur une carte isole ce tour ; les « Contexte injecté » et « Technique » sont masqués par défaut.</li>
          </ul>
          <h3>Cloner / continuer</h3>
          <p className="help">
            Le clone garde les mêmes uuid mais reçoit un nouveau <code>sessionId</code> (réécrit sur chaque ligne) et un marqueur <code>forkedFrom</code>, comme <code>/branch</code>. Le fichier doit s'appeler <code>&lt;sessionId&gt;.jsonl</code>. Vérifié avec Claude Code 2.1.302 : <code>claude --resume &lt;id&gt;</code> (fichier dans ~/.claude/projects/…) et <code>claude --resume /chemin/absolu.jsonl</code> reprennent le clone avec tout le contexte.
          </p>
        </div>
      )}
    </aside>
  );
}
