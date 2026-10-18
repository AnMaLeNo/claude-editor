import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseLines, normalize, computeStats, quickSummary, cloneTranscript } from './parse.js';

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

const app = express();
app.use(express.json({ limit: '1mb' }));
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
