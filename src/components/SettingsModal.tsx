import { useEffect, useState } from 'react';
import type { AiSettings } from '../types';
import { api } from '../api';
import { Modal } from './Modal';

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<AiSettings | null>(null);
  const [key, setKey] = useState('');
  const [envText, setEnvText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    api
      .settings()
      .then((x) => {
        setS(x);
        setEnvText(
          Object.entries(x.extraEnv ?? {})
            .map(([k, v]) => `${k}=${v}`)
            .join('\n'),
        );
      })
      .catch((e) => setErr(e.message));
  }, []);
  if (!s) return <Modal title="Paramètres IA" onClose={onClose}>{err ?? 'Chargement…'}</Modal>;
  const save = async () => {
    setErr(null);
    const extraEnv: Record<string, string> = {};
    for (const line of envText.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m) extraEnv[m[1]] = m[2];
    }
    try {
      const body: Partial<AiSettings> = { ...s, extraEnv };
      if (key.trim()) body.openrouterApiKey = key.trim();
      else delete body.openrouterApiKey;
      const r = await api.saveSettings(body);
      setS(r);
      setKey('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Modal title="Paramètres IA" onClose={onClose}>
      <div className="settings">
        <h3>Recherche IA — JEV (OpenRouter)</h3>
        <p className="help">
          Modèle de décision TypeSafe : pour chaque entrée, « correspond-elle à la recherche ? » (probabilité) + score de pertinence. ~0,04 $ / million de tokens d'entrée, sortie gratuite, 0,3 s par lot.
        </p>
        <label>
          Modèle JEV
          <input value={s.jevModel} onChange={(e) => setS({ ...s, jevModel: e.target.value })} placeholder="typesafe/jev-1.13" />
        </label>
        <label>
          Clé OpenRouter {s.hasOpenrouterKey ? <span className="badge ok">définie</span> : <span className="badge err">manquante</span>}
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={s.hasOpenrouterKey ? '(inchangée — saisir pour remplacer)' : 'sk-or-…'} autoComplete="off" />
        </label>
        <p className="help">Stockée dans <code>data/settings.json</code> sur cette machine, jamais renvoyée au navigateur. La variable d'environnement <code>OPENROUTER_API_KEY</code> du serveur est aussi acceptée.</p>

        <h3>Réécriture IA — <code>claude -p</code></h3>
        <p className="help">
          Chaque texte sélectionné est envoyé seul, avec ton instruction, à <code>claude -p</code> : system prompt neutre, aucun outil, un seul tour, aucune information sur l'origine du texte. Utilise ton compte Claude Code (déjà connecté sur cette machine).
        </p>
        <div className="grid2">
          <label>
            Binaire
            <input value={s.claudePath} onChange={(e) => setS({ ...s, claudePath: e.target.value })} placeholder="claude" />
          </label>
          <label>
            Modèle (<code>--model</code>)
            <input value={s.model} onChange={(e) => setS({ ...s, model: e.target.value })} placeholder="(défaut) · sonnet · opus · haiku · nom complet" list="models" />
            <datalist id="models">
              <option value="sonnet" />
              <option value="opus" />
              <option value="haiku" />
            </datalist>
          </label>
          <label>
            Effort (<code>--effort</code>)
            <select value={s.effort} onChange={(e) => setS({ ...s, effort: e.target.value as AiSettings['effort'] })}>
              <option value="">(défaut)</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="xhigh">xhigh</option>
              <option value="max">max</option>
            </select>
          </label>
          <label>
            Réécritures en parallèle
            <input type="number" min={1} max={8} value={s.editConcurrency} onChange={(e) => setS({ ...s, editConcurrency: Number(e.target.value) })} />
          </label>
          <label>
            Délai max par appel (s)
            <input type="number" min={30} max={3600} value={s.timeoutSec} onChange={(e) => setS({ ...s, timeoutSec: Number(e.target.value) })} />
          </label>
        </div>
        <label>
          Variables d'environnement supplémentaires pour <code>claude</code> (une par ligne, <code>CLE=valeur</code>) — ex. <code>ANTHROPIC_BASE_URL</code> / <code>ANTHROPIC_AUTH_TOKEN</code> pour passer par OpenRouter
          <textarea rows={3} value={envText} onChange={(e) => setEnvText(e.target.value)} spellCheck={false} />
        </label>
        {err && <div className="error-box">{err}</div>}
        <div className="row">
          <button className="primary" onClick={save}>
            Enregistrer
          </button>
          {saved && <span className="badge ok">enregistré</span>}
          <button onClick={onClose}>Fermer</button>
        </div>
      </div>
    </Modal>
  );
}
