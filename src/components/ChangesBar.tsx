import { useState } from 'react';
import type { EditOp, Source } from '../types';

export function ChangesBar({
  ops,
  source,
  onSave,
  onCancel,
  onHarmonize,
  busy,
}: {
  ops: EditOp[];
  source: Source;
  onSave: (dest: 'inplace' | 'clone', title?: string) => void;
  onCancel: () => void;
  onHarmonize: () => void;
  busy: boolean;
}) {
  const [title, setTitle] = useState('');
  const n = { set_text: 0, delete: 0, insert_after: 0 };
  for (const o of ops) n[o.op]++;
  const parts = [
    n.set_text && `${n.set_text} texte${n.set_text > 1 ? 's' : ''} modifié${n.set_text > 1 ? 's' : ''}`,
    n.delete && `${n.delete} suppression${n.delete > 1 ? 's' : ''}`,
    n.insert_after && `${n.insert_after} insertion${n.insert_after > 1 ? 's' : ''}`,
  ].filter(Boolean);
  return (
    <div className="changes-bar">
      <b>Modifications en attente :</b> <span>{parts.join(' · ')}</span>
      <span className="hint">(rien n'est écrit tant que tu n'enregistres pas ; la numérotation des lignes est celle du fichier d'origine)</span>
      <span className="spacer" />
      <button onClick={onHarmonize} disabled={busy} title="Réécrire les réponses de Claude qui suivent tes modifications pour qu'elles restent cohérentes">
        ≈ Harmoniser les réponses
      </button>
      <input placeholder="Titre du clone (optionnel)" value={title} onChange={(e) => setTitle(e.target.value)} />
      {source.writable && (
        <button className="primary" disabled={busy} onClick={() => onSave('inplace')} title="Réécrit ce fichier (déposé ou clone)">
          Enregistrer dans ce fichier
        </button>
      )}
      <button className={source.writable ? '' : 'primary'} disabled={busy} onClick={() => onSave('clone', title)} title="Écrit un nouveau fichier avec un nouveau sessionId ; l'original reste intact">
        Enregistrer comme nouveau clone
      </button>
      <button className="danger" disabled={busy} onClick={onCancel}>
        Tout annuler
      </button>
    </div>
  );
}
