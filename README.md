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

## Modifier une conversation

Sur chaque carte : **✎ Modifier** (prompt, réponse de Claude, résultat d'outil), **✕ Supprimer** (un appel d'outil et son résultat partent ensemble), **+ prompt après / + réponse après** (insertion d'un message) ; sur un tour : **✕ tour**. Les modifications restent en attente (aperçu coloré : modifié / supprimé / nouveau) jusqu'à **Enregistrer** :

- *dans ce fichier* pour un fichier déposé ou un clone ;
- *comme nouveau clone* (obligatoire pour une session locale de Claude Code, qui n'est jamais réécrite).

Côté serveur (`server/edit.js`), `applyEdits()` travaille sur les lignes d'origine : remplace les blocs `text` (ou le `content` du `tool_result`), supprime les lignes en cascade appel ↔ résultat, recoud `parentUuid` vers le plus proche ancêtre survivant, met à jour `leafUuid` (`last-prompt`, `summary`), et insère des lignes `user`/`assistant` minimales (`uuid` neuf, `parentUuid` chaîné, `editedBy: "claude-sessions"`). Les blocs de réflexion (signés) ne sont pas modifiables.

Vérifié avec Claude Code 2.1.302 : un fichier avec une réponse réécrite, un échange inséré et un appel d'outil supprimé se reprend avec `claude --resume`, et Claude « se souvient » du texte modifié et de l'échange inséré, mais plus de l'appel supprimé.

## Recherche IA (JEV) et réécriture IA (`claude -p`)

Deux usages IA bien séparés, réglables via **⚙ IA** (stocké côté serveur dans `data/settings.json`, la clé OpenRouter n'est jamais renvoyée au navigateur) :

- **Recherche IA** — modèle de décision [JEV](https://openrouter.ai/docs/guides/community/jev) (`typesafe/jev-1.13`, API Decisions d'OpenRouter : sorties typées Choice / Noul / Score, pas de texte généré, ~0,04 $ par million de tokens d'entrée). Pipeline en deux temps :
  1. **Routage** : un premier appel JEV classe la recherche sur deux axes — *portée* (prompts / réponses de Claude / sorties d'outils / tout) et *type* (mention d'une entité, propos négatifs, citation d'un document, condition/règle, action technique, général). Le routage s'affiche en menus modifiables (avec les probabilités) ; tu peux le corriger et relancer.
  2. **Analyse** : les entrées de la portée sont envoyées par lots (texte brut uniquement), avec pour chacune un Noul « répond à la recherche ? » et un Score sur une échelle à 4 niveaux propre au type. Résultats triés, curseur de seuil, coût / tokens / lots affichés, chaque hit cliquable et cochable.
  Lignes techniques et contexte injecté exclus par défaut (option « technique + contexte »).
- **Réécriture IA** — tu coches des entrées (prompt, réponse, résultat d'outil), tu écris une instruction ; chaque texte est envoyé **seul** à `claude -p` (`--tools ""`, `--max-turns 1`, system prompt neutre, `--no-session-persistence`) avec l'instruction : **aucune indication** sur la nature du texte, son rôle, l'outil ou le contexte de la conversation. Tu vois avant/après, tu corriges ou acceptes chaque proposition ; les acceptées deviennent des modifications en attente à enregistrer comme n'importe quelle édition (jamais écrites automatiquement).

`claude -p` utilise ton login Claude Code ; pour passer par OpenRouter, ajoute dans les variables d'environnement du panneau : `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, `ANTHROPIC_AUTH_TOKEN=<clé>`.

## Cloner / continuer une session

Le clone reproduit `/branch` (`createFork` dans Claude Code) : mêmes `uuid`, `sessionId` réécrit sur chaque ligne, marqueur `forkedFrom`, fichier nommé `<nouveauSessionId>.jsonl`.

Vérifié avec Claude Code 2.1.302 :

```bash
claude --resume <nouveauSessionId>          # clone placé à côté de l'original, lancé depuis le même dossier
claude --resume /chemin/absolu/<id>.jsonl   # clone placé n'importe où
```

L'original n'est jamais modifié ; les sessions locales sont en lecture seule dans l'app (clone-les pour les éditer).
