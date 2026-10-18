// Intégration de `claude -p` : paramètres, recherche IA sur un rendu texte de la conversation,
// réécriture IA d'un texte brut (sans aucun contexte sur sa nature).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';

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

export function runClaude(s, { args, prompt, cwd, timeoutSec }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...(s.extraEnv ?? {}), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    let child;
    try {
      child = spawn(s.claudePath || 'claude', [...commonArgs(s), ...args], { cwd: cwd ?? os.tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'] });
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
      reject(new Error(`Impossible de lancer « ${s.claudePath} » : ${e.message}`));
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

export async function aiSearch(s, { entries, query, includeMeta, onProgress }) {
  const pool = entries.filter((e) => (includeMeta || (e.kind !== 'meta' && e.kind !== 'context')) && e.text.trim());
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
        instructions: `L'entrée ${id} (state.entrees.${id}) correspond-elle à ce que cherche l'utilisateur (state.recherche_de_l_utilisateur) ?`,
        criteria: {
          true: "L'entrée contient ou constitue directement ce que l'utilisateur recherche.",
          false: "L'entrée n'a pas de rapport avec la recherche, ou ne fait qu'y faire allusion.",
        },
      };
      questions[`${id}_score`] = {
        type: 'score',
        instructions: `À quel point l'entrée ${id} (state.entrees.${id}) est-elle pertinente pour la recherche de l'utilisateur (state.recherche_de_l_utilisateur) ?`,
        criteria: SCALE,
      };
    }
    const r = await jevRequest(s, { state, questions });
    cost += r.usage?.cost ?? 0;
    tokens += r.usage?.input_tokens ?? 0;
    for (const e of batch) {
      const id = `L${e.i + 1}`;
      const m = r.answers?.[`${id}_match`];
      const sc = r.answers?.[`${id}_score`];
      hits.push({ line: e.i + 1, i: e.i, p: m?.noul ?? 0, score: sc?.score ?? 0, confidence: sc?.confidence ?? 0 });
    }
    onProgress?.({ batch: b + 1, batches: batches.length, entries: hits.length, total: pool.length });
  }
  hits.sort((a, b) => b.score - a.score || b.p - a.p);
  return { hits, costUSD: cost, inputTokens: tokens, batches: batches.length, scanned: pool.length, model: s.jevModel || 'typesafe/jev-1.13', scale: SCALE };
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

export const newJobId = () => crypto.randomBytes(6).toString('hex');
