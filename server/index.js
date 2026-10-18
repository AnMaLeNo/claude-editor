import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseLines, normalize, computeStats, quickSummary, cloneTranscript } from './parse.js';
import { applyEdits } from './edit.js';
import { loadSettings, saveSettings, aiSearch, aiEditMany, newJobId, aiRoute, ROUTE_SCOPES, ROUTE_TYPES } from './ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT ?? 3001);
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(ROOT, 'data'));
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const CLONES_DIR = path.join(DATA_DIR, 'clones');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

for (const d of [UPLOADS_DIR, CLONES_DIR]) fs.mkdirSync(d, { recursive: true });
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const app = express();
app.use(express.json({ limit: '50mb' }));
const upload = multer({ dest: path.join(DATA_DIR, 'tmp'), limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

// ---- index des fichiers ----------------------------------------------------
const keyOf = (p) => crypto.createHash('sha1').update(p).digest('hex').slice(0, 16);
const index = new Map(); // key -> { path, group, project }
const summaryCache = new Map(); // path -> { mtimeMs, size, summary }

async function listJsonl(dir) {
  try {
    const names = await fsp.readdir(dir);
    return names.filter((n) => n.endsWith('.jsonl')).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

async function scan() {
  index.clear();
  const sources = [];
  const add = (p, group, project) => {
    const key = keyOf(p);
    const src = { key, path: p, group, project };
    index.set(key, src);
    sources.push(src);
  };
  let projects = [];
  try {
    projects = (await fsp.readdir(PROJECTS_DIR, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    /* pas de ~/.claude */
  }
  for (const proj of projects) for (const p of await listJsonl(path.join(PROJECTS_DIR, proj))) add(p, 'local', proj);
  for (const p of await listJsonl(UPLOADS_DIR)) add(p, 'uploads');
  for (const p of await listJsonl(CLONES_DIR)) add(p, 'clones');
  return sources;
}

async function describe(src) {
  const st = await fsp.stat(src.path);
  const cached = summaryCache.get(src.path);
  let summary;
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) summary = cached.summary;
  else {
    try {
      summary = quickSummary(await fsp.readFile(src.path, 'utf8'));
    } catch (e) {
      summary = { error: e.message };
    }
    summaryCache.set(src.path, { mtimeMs: st.mtimeMs, size: st.size, summary });
  }
  const fileId = path.basename(src.path, '.jsonl');
  return {
    ...src,
    fileName: path.basename(src.path),
    fileId,
    size: st.size,
    mtime: st.mtime.toISOString(),
    writable: src.group !== 'local',
    idMismatch: !!summary?.sessionId && summary.sessionId !== fileId,
    ...summary,
  };
}

async function resolveKey(key) {
  if (!index.has(key)) await scan();
  const src = index.get(key);
  if (!src) return null;
  try {
    await fsp.access(src.path);
  } catch {
    await scan();
    return index.get(key) ?? null;
  }
  return src;
}

// ---- API -------------------------------------------------------------------
app.get('/api/config', (_req, res) => {
  res.json({ claudeDir: CLAUDE_DIR, projectsDir: PROJECTS_DIR, dataDir: DATA_DIR, platform: process.platform });
});

app.get('/api/sessions', async (_req, res) => {
  const sources = await scan();
  const out = [];
  for (const s of sources) out.push(await describe(s));
  out.sort((a, b) => (b.last ?? b.mtime).localeCompare(a.last ?? a.mtime));
  res.json({ sessions: out });
});

app.get('/api/sessions/:key', async (req, res) => {
  const src = await resolveKey(req.params.key);
  if (!src) return res.status(404).json({ error: 'Session inconnue' });
  const text = await fsp.readFile(src.path, 'utf8');
  const { raw, errors } = parseLines(text);
  const entries = normalize(raw);
  const stats = computeStats(entries, raw);
  res.json({ source: await describe(src), stats, entries, parseErrors: errors });
});

app.get('/api/sessions/:key/line/:i', async (req, res) => {
  const src = await resolveKey(req.params.key);
  if (!src) return res.status(404).json({ error: 'Session inconnue' });
  const i = Number(req.params.i);
  const text = await fsp.readFile(src.path, 'utf8');
  const line = text.split('\n')[i];
  if (line == null) return res.status(404).json({ error: 'Ligne inconnue' });
  res.type('application/json').send(line);
});

app.get('/api/sessions/:key/download', async (req, res) => {
  const src = await resolveKey(req.params.key);
  if (!src) return res.status(404).json({ error: 'Session inconnue' });
  res.download(src.path, path.basename(src.path));
});

app.put('/api/sessions/:key/content', express.text({ type: '*/*', limit: '2gb' }), async (req, res) => {
  const src = await resolveKey(req.params.key);
  if (!src) return res.status(404).json({ error: 'Session inconnue' });
  if (src.group === 'local') return res.status(403).json({ error: 'Les sessions locales de Claude Code sont en lecture seule : clone-la d\'abord.' });
  const { errors } = parseLines(req.body ?? '');
  if (errors.length) return res.status(400).json({ error: `JSONL invalide (${errors.length} ligne(s))`, details: errors.slice(0, 5) });
  await fsp.writeFile(src.path, req.body, 'utf8');
  res.json({ ok: true, source: await describe(src) });
});

app.delete('/api/sessions/:key', async (req, res) => {
  const src = await resolveKey(req.params.key);
  if (!src) return res.status(404).json({ error: 'Session inconnue' });
  if (src.group === 'local') return res.status(403).json({ error: 'Suppression refusée pour les sessions locales de Claude Code.' });
  await fsp.unlink(src.path);
  await scan();
  res.json({ ok: true });
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier' });
  const text = await fsp.readFile(req.file.path, 'utf8');
  const { raw, errors } = parseLines(text);
  if (!raw.length) {
    await fsp.unlink(req.file.path);
    return res.status(400).json({ error: 'Aucune ligne JSON valide dans ce fichier', details: errors.slice(0, 3) });
  }
  const sessionId = raw.find((r) => typeof r.o.sessionId === 'string')?.o.sessionId;
  const base = path.basename(req.file.originalname, '.jsonl');
  const name = (UUID_RE.test(base) ? base : sessionId ?? base.replace(/[^\w.-]+/g, '_')) + '.jsonl';
  const dest = path.join(UPLOADS_DIR, name);
  await fsp.rename(req.file.path, dest);
  await scan();
  res.json({ source: await describe(index.get(keyOf(dest))), parseErrors: errors.length, truncated: errors.length > 0 && errors.at(-1).i === raw.at(-1)?.i + 1 });
});

app.post('/api/sessions/:key/clone', async (req, res) => {
  const src = await resolveKey(req.params.key);
  if (!src) return res.status(404).json({ error: 'Session inconnue' });
  const { dest = src.group === 'local' ? 'same' : 'workspace', title } = req.body ?? {};
  const text = await fsp.readFile(src.path, 'utf8');
  const newId = crypto.randomUUID();
  const { text: cloned, oldSessionId } = cloneTranscript(text, newId, { title: title?.trim() || undefined });
  const dir = dest === 'same' ? path.dirname(src.path) : CLONES_DIR;
  const target = path.join(dir, `${newId}.jsonl`);
  await fsp.writeFile(target, cloned, 'utf8');
  await scan();
  const source = await describe(index.get(keyOf(target)));
  res.json({
    source,
    oldSessionId,
    newSessionId: newId,
    resumeById: dest === 'same' ? `claude --resume ${newId}` : undefined,
    resumeByPath: `claude --resume "${target}"`,
  });
});

// Édition : applique les ops sur le fichier d'origine puis écrit en place (fichiers déposés/clones)
// ou dans un nouveau clone (obligatoire pour les sessions locales de Claude Code).
app.post('/api/sessions/:key/edit', async (req, res) => {
  const src = await resolveKey(req.params.key);
  if (!src) return res.status(404).json({ error: 'Session inconnue' });
  const { ops = [], dest = src.group === 'local' ? 'clone' : 'inplace', title, cloneDest = 'same' } = req.body ?? {};
  if (!Array.isArray(ops) || !ops.length) return res.status(400).json({ error: 'Aucune modification' });
  if (dest === 'inplace' && src.group === 'local') return res.status(403).json({ error: 'Session locale en lecture seule : enregistre comme clone.' });
  const text = await fsp.readFile(src.path, 'utf8');
  const edited = applyEdits(text, ops);
  if (edited.errors.length) return res.status(400).json({ error: edited.errors.map((e) => e.message).join(' ; '), details: edited.errors });
  let target = src.path;
  let newSessionId;
  if (dest === 'clone') {
    newSessionId = crypto.randomUUID();
    const { text: cloned } = cloneTranscript(edited.text, newSessionId, { title: title?.trim() || undefined });
    const dir = cloneDest === 'same' && src.group === 'local' ? path.dirname(src.path) : CLONES_DIR;
    target = path.join(dir, `${newSessionId}.jsonl`);
    await fsp.writeFile(target, cloned, 'utf8');
  } else {
    await fsp.writeFile(target, edited.text, 'utf8');
  }
  await scan();
  const source = await describe(index.get(keyOf(target)));
  res.json({ source, newSessionId, deleted: edited.deleted, inserted: edited.inserted, resumeByPath: `claude --resume "${target}"`, resumeById: newSessionId && cloneDest === 'same' && src.group === 'local' ? `claude --resume ${newSessionId}` : undefined });
});

// ---- IA ---------------------------------------------------------------------
// La clé OpenRouter n'est jamais renvoyée au navigateur : seulement « définie » ou non.
const publicSettings = (st) => ({ ...st, openrouterApiKey: undefined, hasOpenrouterKey: !!(st.openrouterApiKey || process.env.OPENROUTER_API_KEY) });

app.get('/api/settings', (_req, res) => res.json(publicSettings(loadSettings(SETTINGS_FILE))));
app.put('/api/settings', async (req, res) => {
  const b = req.body ?? {};
  const st = await saveSettings(SETTINGS_FILE, {
    jevModel: String(b.jevModel ?? 'typesafe/jev-1.13').trim() || 'typesafe/jev-1.13',
    openrouterApiKey: b.openrouterApiKey === undefined ? loadSettings(SETTINGS_FILE).openrouterApiKey : String(b.openrouterApiKey ?? '').trim(),
    claudePath: String(b.claudePath ?? 'claude').trim() || 'claude',
    model: String(b.model ?? '').trim(),
    effort: ['', 'low', 'medium', 'high', 'xhigh', 'max'].includes(b.effort) ? b.effort : '',
    extraEnv: Object.fromEntries(Object.entries(b.extraEnv ?? {}).filter(([k, v]) => /^[A-Z_][A-Z0-9_]*$/i.test(k) && typeof v === 'string')),
    searchMaxTurns: Math.max(5, Math.min(200, Number(b.searchMaxTurns) || 40)),
    timeoutSec: Math.max(30, Math.min(3600, Number(b.timeoutSec) || 600)),
    editConcurrency: Math.max(1, Math.min(8, Number(b.editConcurrency) || 3)),
  });
  res.json(publicSettings(st));
});

// Jobs asynchrones (la recherche IA peut durer plusieurs minutes) : POST lance, GET /api/jobs/:id suit.
const jobs = new Map();
const startJob = (fn) => {
  const id = newJobId();
  const job = { id, status: 'running', startedAt: Date.now(), progress: [] };
  jobs.set(id, job);
  fn(job)
    .then((result) => Object.assign(job, { status: 'done', result, endedAt: Date.now() }))
    .catch((e) => Object.assign(job, { status: 'error', error: e.message, endedAt: Date.now() }));
  setTimeout(() => jobs.delete(id), 3600 * 1000).unref();
  return job;
};
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job inconnu ou expiré' });
  res.json(job);
});

app.get('/api/ai-routes', (_req, res) =>
  res.json({
    scopes: Object.fromEntries(Object.entries(ROUTE_SCOPES).map(([k, v]) => [k, { label: v.label, desc: v.desc }])),
    types: Object.fromEntries(Object.entries(ROUTE_TYPES).map(([k, v]) => [k, { label: v.label, desc: v.desc, scale: v.scale }])),
  }),
);

app.post('/api/ai-route', async (req, res) => {
  const { query } = req.body ?? {};
  if (!query?.trim()) return res.status(400).json({ error: 'Demande vide' });
  try {
    res.json(await aiRoute(loadSettings(SETTINGS_FILE), query.trim()));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/sessions/:key/ai-search', async (req, res) => {
  const src = await resolveKey(req.params.key);
  if (!src) return res.status(404).json({ error: 'Session inconnue' });
  const { query, includeMeta = false, scope = 'tout', type = 'general' } = req.body ?? {};
  if (!query?.trim()) return res.status(400).json({ error: 'Demande vide' });
  const text = await fsp.readFile(src.path, 'utf8');
  const entries = normalize(parseLines(text).raw);
  const job = startJob((job) => aiSearch(loadSettings(SETTINGS_FILE), { entries, query: query.trim(), includeMeta, scope, type, onProgress: (p) => job.progress.push(p) }));
  res.json({ jobId: job.id });
});

// items : [{ ref, text }] — on ne transmet à claude que `text` et l'instruction, rien d'autre.
app.post('/api/ai-edit', async (req, res) => {
  const { items, instruction } = req.body ?? {};
  if (!instruction?.trim()) return res.status(400).json({ error: 'Instruction vide' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Aucun texte à modifier' });
  const st = loadSettings(SETTINGS_FILE);
  const job = startJob(async (job) => {
    const results = await aiEditMany(
      st,
      items.map((it) => ({ text: String(it.text ?? ''), instruction: instruction.trim() })),
      (k, r) => job.progress.push({ ref: items[k].ref, ok: r.ok }),
    );
    return { items: items.map((it, k) => ({ ref: it.ref, ...results[k] })) };
  });
  res.json({ jobId: job.id });
});

// ---- front buildé ----------------------------------------------------------
const DIST = path.join(ROOT, 'dist');
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(DIST, 'index.html')));
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`Claude Sessions — API sur http://localhost:${PORT}`);
  console.log(`  transcripts Claude Code : ${PROJECTS_DIR}`);
  console.log(`  espace de travail       : ${DATA_DIR}`);
});
