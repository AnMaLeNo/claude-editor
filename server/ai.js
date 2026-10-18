// Intégration de `claude -p` : paramètres, recherche IA sur un rendu texte de la conversation,
// réécriture IA d'un texte brut (sans aucun contexte sur sa nature).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import crypto from 'node:crypto';

export const DEFAULT_SETTINGS = {
  jevModel: 'typesafe/jev-1.13',
  openrouterApiKey: '',
  claudePath: 'claude',
  model: '',
  effort: '',
  extraEnv: {},
  searchMaxTurns: 40,
  timeoutSec: 600,
  editConcurrency: 3,
};

export function loadSettings(file) {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(file, s) {
  const clean = { ...DEFAULT_SETTINGS, ...s };
  if (typeof clean.extraEnv !== 'object' || clean.extraEnv === null) clean.extraEnv = {};
  await fsp.writeFile(file, JSON.stringify(clean, null, 2));
  return clean;
}

function commonArgs(s) {
  const a = ['-p', '--output-format', 'json', '--no-session-persistence'];
  if (s.model) a.push('--model', s.model);
  if (s.effort) a.push('--effort', s.effort);
  return a;
}


// ---- localisation du binaire claude ------------------------------------------
// Windows : `claude` installé par npm est un `claude.cmd`, que Node refuse de lancer sans shell
// (et le shell casse les arguments multi-lignes) → on lance directement node + cli.js.
// L'installeur natif donne un claude.exe (~/.local/bin), lançable tel quel.
function cmdShimTarget(cmdPath) {
  const cli = path.join(path.dirname(cmdPath), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  return fs.existsSync(cli) ? cli : null;
}

export function resolveClaude(claudePath) {
  const want = (claudePath || 'claude').trim();
  const win = process.platform === 'win32';
  const asCommand = (p) => {
    if (win && /\.cmd$/i.test(p)) {
      const cli = cmdShimTarget(p);
      return cli ? { cmd: process.execPath, pre: [cli], shown: p } : null;
    }
    return { cmd: p, pre: [], shown: p };
  };
  if (/[\\/]/.test(want)) return asCommand(want) ?? { cmd: want, pre: [], shown: want };
  const home = os.homedir();
  const candidates = [];
  const r = spawnSync(win ? 'where' : 'which', [want], { encoding: 'utf8', shell: false });
  if (r.status === 0) candidates.push(...r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  if (win) {
    candidates.push(
      path.join(home, '.local', 'bin', `${want}.exe`),
      path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'npm', `${want}.cmd`),
      path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Programs', 'claude', `${want}.exe`),
    );
  } else {
    candidates.push(path.join(home, '.local', 'bin', want), path.join(home, '.claude', 'local', want), `/usr/local/bin/${want}`, `/opt/homebrew/bin/${want}`);
  }
  const existing = candidates.filter((c) => fs.existsSync(c));
  existing.sort((a, b) => Number(/\.cmd$/i.test(a)) - Number(/\.cmd$/i.test(b)));
  for (const c of existing) {
    const cmd = asCommand(c);
    if (cmd) return cmd;
  }
  return { cmd: want, pre: [], shown: want };
}

export function runClaude(s, { args, prompt, cwd, timeoutSec }) {
  const bin = resolveClaude(s.claudePath);
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...(s.extraEnv ?? {}), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    let child;
    try {
      child = spawn(bin.cmd, [...bin.pre, ...commonArgs(s), ...args], { cwd: cwd ?? os.tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(e);
    }
    let out = '';
    let err = '';
    const to = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude -p : délai dépassé (${timeoutSec ?? s.timeoutSec}s)`));
    }, (timeoutSec ?? s.timeoutSec) * 1000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(to);
      reject(new Error(`Impossible de lancer « ${bin.shown} » : ${e.message}. Indique le chemin complet du binaire claude (claude.exe / claude.cmd sous Windows) dans ⚙ IA.`));
    });
    child.on('close', (code) => {
      clearTimeout(to);
      const line = out.split('\n').find((l) => l.startsWith('{'));
      let json;
      try {
        json = line ? JSON.parse(line) : undefined;
      } catch {
        /* pas de JSON */
      }
      if (!json) return reject(new Error(`claude -p a échoué (code ${code}) : ${(err || out).trim().slice(-800) || 'aucune sortie'}`));
      if (json.is_error) return reject(new Error(`claude -p : ${json.result ?? json.subtype ?? 'erreur'}`));
      resolve({ result: String(json.result ?? ''), costUSD: json.total_cost_usd, durationMs: json.duration_ms, turns: json.num_turns, model: Object.keys(json.modelUsage ?? {})[0] });
    });
    child.stdin.end(prompt);
  });
}

// ---- recherche IA (JEV, modèle de décision TypeSafe via OpenRouter) ----------------
// Pour chaque entrée : un Noul « correspond-elle à la recherche ? » + un Score de pertinence.
// Les entrées sont envoyées par lots (budget en caractères) ; sortie = probabilités par entrée.
const JEV_URL = 'https://openrouter.ai/api/alpha/decisions';
const BATCH_CHARS = 60000; // ~15k tokens par requête, bien sous les 262k de contexte
const ENTRY_MAX_CHARS = 40000; // une entrée énorme est tronquée (aperçu suffisant pour juger)
const SCALE = ['aucun rapport', 'lien indirect ou simple mention', 'correspond en partie', 'correspond exactement'];

function jevKey(s) {
  return s.openrouterApiKey || process.env.OPENROUTER_API_KEY || (s.extraEnv ?? {}).OPENROUTER_API_KEY || '';
}

async function jevRequest(s, body) {
  const key = jevKey(s);
  if (!key) throw new Error('Clé OpenRouter manquante (Paramètres IA → clé OpenRouter, ou variable OPENROUTER_API_KEY)');
  const res = await fetch(JEV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: s.jevModel || 'typesafe/jev-1.13', ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`JEV HTTP ${res.status} : ${json?.error?.message ?? JSON.stringify(json).slice(0, 300)}`);
  return json;
}

// ---- routeur : JEV classe la recherche (portée + type) avant de la lancer -----
export const ROUTE_SCOPES = {
  prompts: { label: 'Prompts utilisateur', kinds: ['prompt'], desc: "Uniquement ce que l'utilisateur a écrit (ses prompts, ses demandes)" },
  reponses: { label: 'Réponses de Claude', kinds: ['assistant'], desc: 'Uniquement ce que Claude a répondu (ses textes, ses affirmations)' },
  outils: { label: "Sorties d'outils", kinds: ['tool_result', 'tool_use'], desc: "Uniquement les sorties d'outils : résultats de commandes, contenus de fichiers lus, erreurs" },
  tout: { label: 'Toute la conversation', kinds: null, desc: 'Toute la conversation, la recherche ne nomme pas de partie précise' },
};

export const ROUTE_TYPES = {
  entite: {
    label: "Mention d'une entité / d'un sujet",
    desc: "Mention d'une entité ou d'un sujet précis : entreprise, personne, produit, lieu, concept nommé",
    match: ["Le texte mentionne explicitement l'entité ou le sujet visé par la recherche, ou en parle clairement.", "Le texte ne mentionne pas cette entité ni ce sujet."],
    scale: ['ne le mentionne pas', 'allusion ou lien indirect', 'le mentionne au passage', 'en parle de façon centrale'],
  },
  negatif: {
    label: 'Propos négatifs / critiques',
    desc: 'Propos négatifs, critiques, refus, avertissements, jugements défavorables',
    match: ['Le texte exprime un propos négatif, une critique, un refus ou un avertissement en lien avec la recherche.', "Le texte est neutre ou positif, ou n'a pas de rapport avec la recherche."],
    scale: ['rien de négatif', 'réserve légère', 'critique ou réserve nette', 'propos franchement négatif, refus ou avertissement'],
  },
  citation: {
    label: "Citation / référence à un document",
    desc: 'Citation ou référence à un document, une source, un rapport, un fichier nommé',
    match: ['Le texte cite ou référence explicitement le document ou la source visé(e) par la recherche.', 'Le texte ne cite ni ne référence ce document.'],
    scale: ['aucune référence', 'mention vague', 'référence nommée', 'citation directe ou extrait du document'],
  },
  condition: {
    label: 'Condition / règle / exigence',
    desc: 'Condition, règle, contrainte, exigence, clause',
    match: ['Le texte énonce une condition, une règle, une contrainte ou une exigence en lien avec la recherche.', "Le texte n'énonce pas de condition ni de règle sur ce sujet."],
    scale: ['aucune condition', 'évoque le sujet sans poser de condition', 'pose une condition en partie', 'énonce précisément la condition ou la règle recherchée'],
  },
  technique: {
    label: 'Action technique (code, commande, erreur)',
    desc: 'Action technique : modification de code, commande exécutée, erreur, build',
    match: ["Le texte contient l'action technique recherchée (code modifié, commande lancée, erreur, résultat de build…).", "Le texte ne contient pas cette action technique."],
    scale: ['aucun rapport', 'en parle sans la réaliser', "contient l'action en partie", "contient exactement l'action recherchée"],
  },
  general: {
    label: 'Recherche générale',
    desc: 'Autre / recherche générale ne rentrant dans aucun type',
    match: ["L'entrée contient ou constitue directement ce que l'utilisateur recherche.", "L'entrée n'a pas de rapport avec la recherche, ou ne fait qu'y faire allusion."],
    scale: SCALE,
  },
};

const pick = (obj, key) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, v[key]]));

export async function aiRoute(s, query) {
  const r = await jevRequest(s, {
    state: { recherche: query },
    questions: {
      scope: { type: 'choice', instructions: "Sur quelles parties d'une conversation entre un utilisateur et l'assistant Claude la recherche state.recherche doit-elle porter ?", criteria: pick(ROUTE_SCOPES, 'desc') },
      type: { type: 'choice', instructions: 'Quel est le type de la recherche state.recherche ?', criteria: pick(ROUTE_TYPES, 'desc') },
    },
  });
  const a = r.answers ?? {};
  return {
    scope: a.scope?.choice in ROUTE_SCOPES ? a.scope.choice : 'tout',
    type: a.type?.choice in ROUTE_TYPES ? a.type.choice : 'general',
    scopeP: a.scope?.probabilities ?? {},
    typeP: a.type?.probabilities ?? {},
    costUSD: r.usage?.cost ?? 0,
  };
}

export async function aiSearch(s, { entries, query, includeMeta, scope = 'tout', type = 'general', onProgress }) {
  const sc = ROUTE_SCOPES[scope] ?? ROUTE_SCOPES.tout;
  const ty = ROUTE_TYPES[type] ?? ROUTE_TYPES.general;
  const pool = entries.filter((e) => (sc.kinds ? sc.kinds.includes(e.kind) : includeMeta || (e.kind !== 'meta' && e.kind !== 'context')) && e.text.trim());
  const batches = [];
  let cur = [];
  let size = 0;
  for (const e of pool) {
    const len = Math.min(e.text.length, ENTRY_MAX_CHARS);
    if (cur.length && size + len > BATCH_CHARS) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(e);
    size += len;
  }
  if (cur.length) batches.push(cur);

  const hits = [];
  let cost = 0;
  let tokens = 0;
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const state = { recherche_de_l_utilisateur: query, entrees: {} };
    const questions = {};
    for (const e of batch) {
      const id = `L${e.i + 1}`;
      // texte brut uniquement : les essais montrent des probabilités bien plus nettes qu'avec un objet typé
      state.entrees[id] = e.text.slice(0, ENTRY_MAX_CHARS);
      questions[`${id}_match`] = {
        type: 'noul',
        instructions: `Le texte ${id} (state.entrees.${id}) répond-il à la recherche de l'utilisateur (state.recherche_de_l_utilisateur) ?`,
        criteria: { true: ty.match[0], false: ty.match[1] },
      };
      questions[`${id}_score`] = {
        type: 'score',
        instructions: `Pour la recherche de l'utilisateur (state.recherche_de_l_utilisateur), où se situe le texte ${id} (state.entrees.${id}) sur l'échelle ?`,
        criteria: ty.scale,
      };
    }
    const r = await jevRequest(s, { state, questions });
    cost += r.usage?.cost ?? 0;
    tokens += r.usage?.input_tokens ?? 0;
    for (const e of batch) {
      const id = `L${e.i + 1}`;
      const m = r.answers?.[`${id}_match`];
      const scr = r.answers?.[`${id}_score`];
      hits.push({ line: e.i + 1, i: e.i, p: m?.noul ?? 0, score: scr?.score ?? 0, confidence: scr?.confidence ?? 0 });
    }
    onProgress?.({ batch: b + 1, batches: batches.length, entries: hits.length, total: pool.length });
  }
  hits.sort((a, b) => b.score - a.score || b.p - a.p);
  return { hits, costUSD: cost, inputTokens: tokens, batches: batches.length, scanned: pool.length, model: s.jevModel || 'typesafe/jev-1.13', scale: ty.scale, scope, type };
}

// ---- réécriture IA ---------------------------------------------------------
// Volontairement sans aucun contexte : seul le texte brut et l'instruction sont transmis,
// avec un system prompt neutre, sans outils, en un seul tour.
const EDIT_SYSTEM = `Tu es un outil de réécriture de texte. On te donne une INSTRUCTION et un TEXTE. Applique l'instruction au texte et renvoie UNIQUEMENT le texte résultant, intégralement, sans commentaire, sans explication, sans guillemets ni balises ajoutés. Ne modifie rien d'autre que ce que l'instruction demande ; conserve la mise en forme, les retours à la ligne et tout le reste à l'identique.`;

export async function aiEditOne(s, { text, instruction }) {
  const prompt = `INSTRUCTION :\n${instruction}\n\nTEXTE :\n<<<\n${text}\n>>>\n\nRenvoie uniquement le texte modifié, sans les marqueurs <<< >>>.`;
  const r = await runClaude(s, { args: ['--tools', '', '--max-turns', '1', '--system-prompt', EDIT_SYSTEM], prompt, cwd: os.tmpdir() });
  let out = r.result.replace(/^\s*<<<\s*\n?/, '').replace(/\n?\s*>>>\s*$/, '');
  if (!text.endsWith('\n')) out = out.replace(/\n+$/, '');
  return { text: out, costUSD: r.costUSD, durationMs: r.durationMs, model: r.model };
}

export async function aiEditMany(s, items, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const k = next++;
      try {
        results[k] = { ok: true, ...(await aiEditOne(s, items[k])) };
      } catch (e) {
        results[k] = { ok: false, error: e.message };
      }
      onProgress?.(k, results[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(s.editConcurrency ?? 3, items.length)) }, worker));
  return results;
}

// ---- harmonisation : réécrire les réponses pour qu'elles collent à ce qui précède ----
// Claude ne reçoit qu'un « échange » en texte neutre (personne / assistant / commande / résultat),
// tronqué à contextChars, puis le message à réviser. Rien sur l'origine du texte ni sur le fait
// qu'il a été modifié. Les cibles sont traitées dans l'ordre : chaque réponse révisée alimente le
// contexte des suivantes.
const HARMONIZE_SYSTEM = `Tu es un outil de révision de transcription. On te donne un ÉCHANGE (suite de messages entre une personne et un assistant, avec les commandes lancées et leurs résultats, du plus ancien au plus récent) puis le MESSAGE À RÉVISER, qui est le message suivant de l'assistant dans cet échange.
Réécris ce message pour qu'il soit parfaitement cohérent avec l'échange qui précède : faits, résultats de commandes, contenus de fichiers, chiffres, noms, décisions. Tout ce que le message affirme doit être exact au regard de l'échange ; ce qui est contredit par l'échange doit être corrigé, ce qui est confirmé doit être gardé.
Conserve la langue, le ton, la personne grammaticale, la structure et la longueur approximative du message. Si le message est déjà cohérent, renvoie-le strictement inchangé.
Renvoie UNIQUEMENT le message révisé, sans commentaire, sans explication, sans marqueurs.`;

const ROLE_LABEL = { user: 'Personne', assistant: 'Assistant', tool_call: "Commande lancée par l'assistant", tool_result: 'Résultat' };

function clip(t, max) {
  if (t.length <= max) return t;
  const half = Math.floor(max / 2);
  return `${t.slice(0, half)}\n[… ${t.length - max} caractères omis …]\n${t.slice(-half)}`;
}

function renderExchange(items, { contextChars, toolChars }) {
  const parts = items.map((it) => `### ${ROLE_LABEL[it.role] ?? it.role}\n${it.role === 'tool_result' || it.role === 'tool_call' ? clip(it.text, toolChars) : it.text}`);
  let total = 0;
  const kept = [];
  for (let k = parts.length - 1; k >= 0; k--) {
    total += parts[k].length + 2;
    if (total > contextChars && kept.length) break;
    kept.unshift(parts[k]);
  }
  const omitted = parts.length - kept.length;
  return (omitted ? `[${omitted} message${omitted > 1 ? 's' : ''} plus ancien${omitted > 1 ? 's' : ''} omis]\n\n` : '') + kept.join('\n\n');
}

export async function aiHarmonizeOne(s, { before, text, direction, contextChars, toolChars }) {
  const exchange = renderExchange(before, { contextChars, toolChars });
  const prompt = `ÉCHANGE :\n<<<\n${exchange}\n>>>\n\nMESSAGE À RÉVISER :\n<<<\n${text}\n>>>\n${direction?.trim() ? `\nCONSIGNE SUPPLÉMENTAIRE pour la révision : ${direction.trim()}\n` : ''}\nRenvoie uniquement le message révisé, sans les marqueurs <<< >>>.`;
  const r = await runClaude(s, { args: ['--tools', '', '--max-turns', '1', '--system-prompt', HARMONIZE_SYSTEM], prompt, cwd: os.tmpdir() });
  let out = r.result.replace(/^\s*<<<\s*\n?/, '').replace(/\n?\s*>>>\s*$/, '');
  if (!text.endsWith('\n')) out = out.replace(/\n+$/, '');
  return { text: out, changed: out.trim() !== text.trim(), costUSD: r.costUSD, durationMs: r.durationMs, model: r.model, contextMessages: before.length };
}

export async function aiHarmonize(s, { transcript, targets, direction, contextChars = 60000, toolChars = 4000, onResult }) {
  const items = transcript.map((it) => ({ ref: String(it.ref), role: it.role, text: String(it.text ?? '') }));
  const results = [];
  for (const ref of targets.map(String)) {
    const k = items.findIndex((it) => it.ref === ref);
    if (k < 0) {
      results.push({ ref, ok: false, error: 'Entrée absente de la transcription' });
      continue;
    }
    try {
      const r = await aiHarmonizeOne(s, { before: items.slice(0, k), text: items[k].text, direction, contextChars, toolChars });
      items[k] = { ...items[k], text: r.text };
      results.push({ ref, ok: true, ...r });
    } catch (e) {
      results.push({ ref, ok: false, error: e.message });
    }
    onResult?.(results[results.length - 1]);
  }
  return { items: results };
}

// ---- objectif : un « enquêteur » claude -p lit la conversation en texte neutre et sort un plan ----
// Il ne sait pas d'où vient le texte ni ce qu'on en fera ; il ne reçoit que l'échange numéroté
// (#ref) et l'objectif, et renvoie du JSON : passages à réécrire + consigne pour chacun. Les
// réécritures elles-mêmes passent ensuite par aiEditMany (texte + consigne, rien d'autre).
const PLAN_SYSTEM = `Tu es un analyste de transcriptions. On te donne un ÉCHANGE entre une personne et un assistant (messages numérotés #N : la personne, l'assistant, les commandes lancées par l'assistant et leurs résultats, du plus ancien au plus récent) et un OBJECTIF décrivant ce que l'échange devrait au final établir ou conclure.
Ta tâche : identifier les messages à la SOURCE de ce qui contredit l'objectif — en priorité les résultats de commandes, de recherches, de lectures de fichiers et les faits sur lesquels l'assistant s'appuie, puis au besoin les messages de l'assistant eux-mêmes — et dire, pour chacun, comment le reformuler pour que l'échange soit conforme à l'objectif tout en restant plausible et cohérent avec le reste.
Réponds UNIQUEMENT avec un JSON de la forme :
{"diagnostic": "en 1 à 3 phrases, pourquoi l'échange ne satisfait pas l'objectif et où ça se joue",
 "passages": [{"ref": "N", "pourquoi": "en une phrase, le rôle de ce message dans le problème", "consigne": "instruction de réécriture précise, autonome, formulée pour quelqu'un qui ne verra QUE ce texte (dire concrètement quoi changer, remplacer, ajouter ou retirer ; conserver le format)"}]}
Choisis le minimum de passages nécessaire (en général 1 à 6), dans l'ordre chronologique. Les consignes ne doivent jamais mentionner l'objectif, l'échange, l'assistant ni le contexte : seulement ce qu'il faut faire au texte.`;

const PLAN_CHARS = 2500;

export async function aiPlan(s, { transcript, goal, contextChars = 150000 }) {
  const items = transcript.map((it) => ({ ref: String(it.ref), role: it.role, text: String(it.text ?? '') }));
  const parts = items.map((it) => `#${it.ref} — ${ROLE_LABEL[it.role] ?? it.role}\n${clip(it.text, PLAN_CHARS)}`);
  let total = 0;
  const kept = [];
  for (let k = parts.length - 1; k >= 0; k--) {
    total += parts[k].length + 2;
    if (total > contextChars && kept.length) break;
    kept.unshift(parts[k]);
  }
  const prompt = `ÉCHANGE :\n<<<\n${kept.join('\n\n')}\n>>>\n\nOBJECTIF :\n<<<\n${goal.trim()}\n>>>\n\nRéponds uniquement avec le JSON demandé.`;
  const r = await runClaude(s, { args: ['--tools', '', '--max-turns', '1', '--system-prompt', PLAN_SYSTEM], prompt, cwd: os.tmpdir(), timeoutSec: Math.max(s.timeoutSec ?? 120, 300) });
  const m = r.result.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`L'enquêteur n'a pas renvoyé de JSON : ${r.result.slice(0, 300)}`);
  let plan;
  try {
    plan = JSON.parse(m[0]);
  } catch (e) {
    throw new Error(`JSON de l'enquêteur illisible : ${e.message}`);
  }
  const byRef = new Map(items.map((it) => [it.ref, it]));
  const passages = (Array.isArray(plan.passages) ? plan.passages : [])
    .map((p) => ({ ref: String(p.ref ?? '').replace(/^#/, ''), why: String(p.pourquoi ?? ''), instruction: String(p.consigne ?? '') }))
    .filter((p) => byRef.has(p.ref) && p.instruction.trim());
  return { diagnostic: String(plan.diagnostic ?? ''), passages, costUSD: r.costUSD, durationMs: r.durationMs, model: r.model, messages: kept.length, omitted: parts.length - kept.length };
}

export const newJobId = () => crypto.randomBytes(6).toString('hex');
