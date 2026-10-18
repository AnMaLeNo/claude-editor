# Claude Sessions

Explorateur, moteur de recherche et cloneur de conversations **Claude Code** (fichiers `.jsonl`).

- **Front** (React + Vite) : liste des sessions, timeline par tours, filtres par type / outil / tour / date / erreurs, recherche plein texte (regex, casse, mot entier) avec navigation, JSON brut de chaque ligne, statistiques (tokens, coût, outils), guide intégré.
- **Mini-back** (Node + Express) : lit `~/.claude/projects/**/*.jsonl` (ou `CLAUDE_CONFIG_DIR`), accepte des fichiers déposés, **clone** une session avec un nouveau `sessionId` pour la reprendre avec `claude --resume`, télécharge / sauvegarde / supprime les fichiers de l'espace de travail.

## Lancer

```bash
npm install
npm start            # build du front + serveur sur http://localhost:3001
```

En développement : `npm run server` (API, port 3001) et `npm run dev` (Vite, port 5173, proxy `/api`).

Variables : `PORT` (3001), `CLAUDE_CONFIG_DIR` (`~/.claude`), `DATA_DIR` (`./data` : `uploads/`, `clones/`).

## Format des transcripts (observé sur Claude Code 2.1.30x)

`~/.claude/projects/<cwd avec / et : remplacés par ->/<sessionId>.jsonl`, une entrée JSON par ligne. Format interne, non documenté, susceptible de changer.

| `type` | rôle |
| - | - |
| `user` | prompt (contenu texte) **ou** résultats d'outils (`tool_result`) **ou** message meta (`isMeta`) ou résumé de compaction (`isCompactSummary`) |
| `assistant` | un bloc par ligne : `thinking`, `tool_use`, `text` ; `message.usage` partagé par les lignes d'un même `message.id` |
| `system` | événements (`compact_boundary`, `api_error`, `file_snapshot`…) |
| `attachment` | contexte injecté (system-reminders : environnement, date, skills, `prompt_snapshot`…) |
| `summary`, `custom-title`, `ai-title` | titres / résumés |
| `queue-operation`, `last-prompt`, `atis-latch`, `cost-state`, `api-request*`, `file-history-snapshot`… | technique |

Les entrées conversationnelles sont chaînées par `uuid` / `parentUuid` ; au `--resume`, Claude Code remonte la chaîne depuis la dernière ligne. `isSidechain: true` = sous-agent.

## Cloner / continuer une session

Le clone reproduit `/branch` (`createFork` dans Claude Code) : mêmes `uuid`, `sessionId` réécrit sur chaque ligne, marqueur `forkedFrom`, fichier nommé `<nouveauSessionId>.jsonl`.

Vérifié avec Claude Code 2.1.302 :

```bash
claude --resume <nouveauSessionId>          # clone placé à côté de l'original, lancé depuis le même dossier
claude --resume /chemin/absolu/<id>.jsonl   # clone placé n'importe où
```

L'original n'est jamais modifié ; les sessions locales sont en lecture seule dans l'app (clone-les pour les éditer).
