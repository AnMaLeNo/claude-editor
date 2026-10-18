// Parsing / normalisation d'un transcript Claude Code (.jsonl).
// Format interne à Claude Code, observé sur la v2.1.3xx ; tout champ inconnu est conservé
// dans la ligne brute (accessible via /line/:i) mais n'est pas interprété ici.

const HEAVY_TYPES = new Set(['api-request-blob', 'api-request-shape', 'api-request', 'file-history-snapshot']);
const HEAVY_ATTACHMENTS = new Set(['prompt_snapshot', 'skill_listing', 'deferred_tools_delta', 'mcp_instructions_delta']);
const PREVIEW_CHARS = 3000;

export const KINDS = ['prompt', 'assistant', 'thinking', 'tool_use', 'tool_result', 'system', 'context', 'summary', 'meta'];

function blocks(message) {
  const c = message?.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? c : [];
}

function toolResultText(block) {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : JSON.stringify(b))).join('\n');
  }
  return c == null ? '' : JSON.stringify(c);
}

function compactJson(o, max) {
  const s = JSON.stringify(o, null, 2);
  return s.length > max ? s.slice(0, max) : s;
}

export function parseLines(text) {
  const raw = [];
  const errors = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    try {
      raw.push({ i, bytes: Buffer.byteLength(l, 'utf8'), o: JSON.parse(l) });
    } catch (e) {
      errors.push({ i, message: e.message, preview: l.slice(0, 200) });
    }
  }
  return { raw, errors };
}

export function normalize(raw) {
  const toolNames = new Map(); // tool_use id -> {name, uuid, i}
  const entries = [];
  let turn = 0;
  for (const { i, o, bytes } of raw) {
    const e = {
      i,
      bytes,
      type: o.type,
      subtype: undefined,
      kind: 'meta',
      uuid: o.uuid,
      parentUuid: o.parentUuid ?? null,
      ts: o.timestamp,
      sidechain: !!o.isSidechain,
      agentId: o.agentId,
      promptId: o.promptId,
      turn,
      title: o.type,
      text: '',
      heavy: false,
    };
    const m = o.message;
    switch (o.type) {
      case 'user': {
        const bs = blocks(m);
        const results = bs.filter((b) => b.type === 'tool_result');
        if (results.length) {
          e.kind = 'tool_result';
          const tools = results.map((b) => {
            const ref = toolNames.get(b.tool_use_id);
            return { id: b.tool_use_id, name: ref?.name ?? '?', useUuid: ref?.uuid, useIndex: ref?.i, isError: !!b.is_error };
          });
          e.tools = tools;
          e.isError = tools.some((t) => t.isError);
          e.title = 'Résultat ' + tools.map((t) => t.name).join(', ');
          e.text = results.map(toolResultText).join('\n\n');
          if (o.toolUseResult && typeof o.toolUseResult === 'object') {
            const r = o.toolUseResult;
            e.result = {
              durationMs: r.durationMs,
              interrupted: r.interrupted,
              filePath: r.filePath ?? r.file?.filePath,
              url: r.url,
              stderr: r.stderr || undefined,
            };
          }
          e.permission = o.permissionDecision?.decision;
        } else if (o.isCompactSummary) {
          e.kind = 'summary';
          e.title = 'Résumé de compaction';
          e.text = bs.map((b) => b.text ?? '').join('\n');
        } else if (o.isMeta) {
          e.kind = 'context';
          e.subtype = 'meta-user';
          e.title = 'Message système (meta)';
          e.text = bs.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n');
        } else {
          turn += 1;
          e.turn = turn;
          e.kind = 'prompt';
          e.title = 'Prompt utilisateur';
          e.text = bs.map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : `[${b.type}]`)).join('\n');
          e.permissionMode = o.permissionMode;
          e.origin = o.origin?.kind ?? o.promptSource;
        }
        break;
      }
      case 'assistant': {
        const bs = blocks(m);
        const uses = bs.filter((b) => b.type === 'tool_use');
        const texts = bs.filter((b) => b.type === 'text');
        const thinks = bs.filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking');
        for (const u of uses) toolNames.set(u.id, { name: u.name, uuid: o.uuid, i });
        e.model = m?.model;
        e.msgId = m?.id;
        e.stopReason = m?.stop_reason;
        if (m?.usage) e.usage = m.usage;
        if (uses.length) {
          e.kind = 'tool_use';
          e.tools = uses.map((u) => ({ id: u.id, name: u.name, input: u.input }));
          e.title = 'Appel ' + uses.map((u) => u.name).join(', ');
          e.text = uses.map((u) => summarizeToolInput(u)).join('\n\n');
          if (texts.length) e.text = texts.map((b) => b.text).join('\n') + '\n\n' + e.text;
        } else if (texts.length) {
          e.kind = 'assistant';
          e.title = 'Réponse de Claude';
          e.text = texts.map((b) => b.text).join('\n');
        } else if (thinks.length) {
          e.kind = 'thinking';
          e.title = 'Réflexion';
          const t = thinks.map((b) => b.thinking ?? '[réflexion masquée]').join('\n');
          e.text = t.trim() ? t : '[réflexion vide ou omise]';
        } else {
          e.kind = 'assistant';
          e.title = 'Réponse (vide)';
        }
        if (thinks.length && e.kind !== 'thinking') e.thinking = thinks.map((b) => b.thinking ?? '').join('\n');
        break;
      }
      case 'system': {
        e.kind = 'system';
        e.subtype = o.subtype;
        e.title = 'Système' + (o.subtype ? ` · ${o.subtype}` : '');
        e.text = typeof o.content === 'string' ? o.content : compactJson(stripCommon(o), PREVIEW_CHARS);
        e.level = o.level;
        break;
      }
      case 'attachment': {
        e.kind = 'context';
        const a = o.attachment ?? {};
        e.subtype = a.type;
        e.title = 'Contexte injecté · ' + (a.type ?? '?');
        const rendered = Array.isArray(o.rendered) ? o.rendered.map((r) => r.content ?? '').join('\n') : '';
        const full = rendered || (typeof a.text === 'string' ? a.text : compactJson(a, 1e9));
        if (HEAVY_ATTACHMENTS.has(a.type) || full.length > 20000) {
          e.heavy = true;
          e.text = full.slice(0, PREVIEW_CHARS);
          e.fullChars = full.length;
        } else e.text = full;
        break;
      }
      case 'summary':
        e.kind = 'summary';
        e.title = 'Résumé de session';
        e.text = o.summary ?? '';
        e.leafUuid = o.leafUuid;
        break;
      case 'custom-title':
      case 'ai-title':
        e.kind = 'summary';
        e.title = o.type === 'custom-title' ? 'Titre (utilisateur)' : 'Titre (généré)';
        e.text = o.customTitle ?? o.aiTitle ?? o.title ?? compactJson(o, 500);
        break;
      default: {
        e.kind = 'meta';
        e.title = 'Technique · ' + o.type;
        if (o.type === 'queue-operation') e.title = `Technique · file d'attente (${o.operation})`;
        if (o.type === 'last-prompt') e.title = 'Technique · dernier prompt';
        if (o.type === 'cost-state') e.title = 'Technique · coût de la session';
        const s = compactJson(stripCommon(o), 1e9);
        if (HEAVY_TYPES.has(o.type) || s.length > 20000) {
          e.heavy = true;
          e.text = s.slice(0, PREVIEW_CHARS);
          e.fullChars = s.length;
        } else e.text = s;
        if (o.type === 'cost-state') e.cost = o;
      }
    }
    entries.push(e);
  }
  return entries;
}

const COMMON_FIELDS = ['userType', 'entrypoint', 'cwd', 'sessionId', 'version', 'gitBranch', 'parentUuid', 'isSidechain', 'uuid', 'timestamp'];
function stripCommon(o) {
  const rest = { ...o };
  for (const k of COMMON_FIELDS) delete rest[k];
  return rest;
}

function summarizeToolInput(u) {
  const inp = u.input ?? {};
  if (u.name === 'Bash' && inp.command) return `$ ${inp.command}${inp.description ? `\n# ${inp.description}` : ''}`;
  if ((u.name === 'Read' || u.name === 'Write' || u.name === 'Edit') && inp.file_path) {
    let s = inp.file_path;
    if (u.name === 'Edit') s += `\n--- old\n${inp.old_string ?? ''}\n+++ new\n${inp.new_string ?? ''}`;
    if (u.name === 'Write') s += `\n${inp.content ?? ''}`;
    return s;
  }
  if (u.name === 'Grep' || u.name === 'Glob') return `${inp.pattern ?? ''}${inp.path ? `  in ${inp.path}` : ''}`;
  if (u.name === 'WebFetch' || u.name === 'WebSearch') return inp.url ?? inp.query ?? JSON.stringify(inp);
  if (u.name === 'Agent' || u.name === 'Task') return `${inp.description ?? ''}\n${inp.prompt ?? ''}`;
  return JSON.stringify(inp, null, 2);
}

export function computeStats(entries, raw) {
  const byKind = Object.fromEntries(KINDS.map((k) => [k, 0]));
  const tools = {};
  let errors = 0;
  let sidechain = 0;
  const models = new Set();
  const usageByMsg = new Map();
  let first, last;
  let turns = 0;
  let compactions = 0;
  for (const e of entries) {
    byKind[e.kind]++;
    if (e.kind === 'tool_use') for (const t of e.tools) tools[t.name] = (tools[t.name] ?? 0) + 1;
    if (e.isError) errors++;
    if (e.sidechain) sidechain++;
    if (e.model) models.add(e.model);
    if (e.usage && e.msgId && !usageByMsg.has(e.msgId)) usageByMsg.set(e.msgId, e.usage);
    if (e.ts) {
      if (!first || e.ts < first) first = e.ts;
      if (!last || e.ts > last) last = e.ts;
    }
    if (e.kind === 'prompt' && !e.sidechain) turns++;
    if (e.type === 'system' && e.subtype === 'compact_boundary') compactions++;
    if (e.kind === 'summary' && e.type === 'user') compactions++;
  }
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, apiCalls: usageByMsg.size };
  for (const u of usageByMsg.values()) {
    usage.input += u.input_tokens ?? 0;
    usage.output += u.output_tokens ?? 0;
    usage.cacheRead += u.cache_read_input_tokens ?? 0;
    usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
    usage.thinking += u.output_tokens_details?.thinking_tokens ?? 0;
  }
  const cost = [...entries].reverse().find((e) => e.cost)?.cost;
  const firstConv = raw.find((r) => r.o.type === 'user' || r.o.type === 'assistant')?.o;
  const titles = entries.filter((e) => e.type === 'custom-title' || e.type === 'ai-title' || e.type === 'summary');
  const firstPrompt = entries.find((e) => e.kind === 'prompt' && !e.sidechain);
  return {
    lines: raw.length,
    bytes: raw.reduce((a, r) => a + r.bytes, 0),
    byKind,
    tools,
    errors,
    sidechain,
    turns,
    compactions,
    models: [...models],
    usage,
    cost: cost
      ? { totalCostUSD: cost.totalCostUSD, totalDuration: cost.totalDuration, linesAdded: cost.totalLinesAdded, linesRemoved: cost.totalLinesRemoved }
      : undefined,
    first,
    last,
    sessionId: firstConv?.sessionId,
    cwd: firstConv?.cwd,
    gitBranch: firstConv?.gitBranch,
    version: firstConv?.version,
    entrypoint: firstConv?.entrypoint,
    title: titles.length ? titles[titles.length - 1].text : undefined,
    firstPrompt: firstPrompt ? cleanPrompt(firstPrompt.text) : undefined,
    forkedFrom: raw.find((r) => r.o.forkedFrom)?.o.forkedFrom?.sessionId,
  };
}

export function cleanPrompt(text) {
  return (text ?? '')
    .replace(/<ide_selection>[\s\S]*?<\/ide_selection>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

// Résumé léger (pour la liste) : lit tout le fichier mais ne normalise que ce qu'il faut.
export function quickSummary(text) {
  const { raw } = parseLines(text);
  const entries = normalize(raw);
  const s = computeStats(entries, raw);
  return {
    lines: s.lines,
    turns: s.turns,
    title: s.title,
    firstPrompt: s.firstPrompt,
    first: s.first,
    last: s.last,
    cwd: s.cwd,
    gitBranch: s.gitBranch,
    sessionId: s.sessionId,
    version: s.version,
    forkedFrom: s.forkedFrom,
    sidechain: s.sidechain,
  };
}

// Clone : même logique que /branch de Claude Code (createFork) — on garde les uuid,
// on réécrit sessionId partout, on marque forkedFrom. Le nom de fichier doit être <sessionId>.jsonl.
export function cloneTranscript(text, newSessionId, { oldSessionId, title } = {}) {
  const out = [];
  let old = oldSessionId;
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue; // ligne corrompue : on la laisse tomber plutôt que de produire un fichier invalide
    }
    if (!old && typeof o.sessionId === 'string') old = o.sessionId;
    if (typeof o.sessionId === 'string') o.sessionId = newSessionId;
    if (o.uuid && (o.type === 'user' || o.type === 'assistant' || o.type === 'system' || o.type === 'attachment') && old) {
      o.forkedFrom = { sessionId: old, messageUuid: o.uuid };
    }
    out.push(JSON.stringify(o));
  }
  if (title) out.push(JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: newSessionId }));
  return { text: out.join('\n') + '\n', oldSessionId: old };
}
