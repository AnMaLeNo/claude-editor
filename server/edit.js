// Application d'opérations d'édition sur un transcript Claude Code, en gardant le fichier
// rechargeable par `claude --resume` : chaîne parentUuid recousue, paires tool_use/tool_result
// supprimées ensemble, leafUuid des lignes last-prompt/summary mis à jour.
//
// ops : { op: 'set_text', i, text }
//       { op: 'delete', i }
//       { op: 'insert_after', i, role: 'user' | 'assistant', text }
// Les index `i` désignent toujours des lignes du fichier d'origine.

import crypto from 'node:crypto';

const CONVERSATIONAL = new Set(['user', 'assistant']);

function parseAll(text) {
  return text.split('\n').map((line) => {
    if (!line.trim()) return null;
    try {
      return { o: JSON.parse(line) };
    } catch {
      return { raw: line };
    }
  });
}

function blocks(o) {
  const c = o.message?.content;
  return Array.isArray(c) ? c : null;
}

function setText(o, text) {
  const m = o.message;
  if (!m) throw new Error('Cette ligne ne contient pas de message');
  if (o.type === 'user') {
    const bs = blocks(o);
    if (!bs) {
      m.content = text;
      return;
    }
    const results = bs.filter((b) => b.type === 'tool_result');
    if (results.length) {
      results[0].content = text;
      for (let k = 1; k < results.length; k++) results[k].content = '';
      if (o.toolUseResult && typeof o.toolUseResult === 'object') o.toolUseResult = { ...o.toolUseResult, edited: true };
      return;
    }
    replaceTextBlocks(m, bs, text);
    return;
  }
  if (o.type === 'assistant') {
    const bs = blocks(o) ?? [];
    if (bs.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking') && !bs.some((b) => b.type === 'text')) {
      throw new Error('Les blocs de réflexion (signés) ne sont pas modifiables');
    }
    replaceTextBlocks(m, bs, text);
    return;
  }
  throw new Error(`Type ${o.type} non modifiable`);
}

function replaceTextBlocks(m, bs, text) {
  const first = bs.findIndex((b) => b.type === 'text');
  const kept = bs.filter((b) => b.type !== 'text');
  const block = { type: 'text', text };
  if (first < 0) kept.push(block);
  else kept.splice(Math.min(first, kept.length), 0, block);
  m.content = kept;
}

function common(anchor) {
  const o = anchor.o;
  return {
    isSidechain: false,
    userType: o.userType,
    entrypoint: o.entrypoint,
    cwd: o.cwd,
    sessionId: o.sessionId,
    version: o.version,
    gitBranch: o.gitBranch,
  };
}

function plusMs(ts, ms) {
  const t = Date.parse(ts);
  return Number.isNaN(t) ? new Date().toISOString() : new Date(t + ms).toISOString();
}

export function applyEdits(text, ops) {
  const lines = parseAll(text);
  const byUuid = new Map();
  for (const l of lines) if (l?.o?.uuid) byUuid.set(l.o.uuid, l.o);
  const get = (i) => {
    const l = lines[i];
    if (!l?.o) throw new Error(`Ligne ${i + 1} introuvable ou illisible`);
    return l.o;
  };
  const errors = [];

  // 1. textes
  for (const op of ops.filter((x) => x.op === 'set_text')) {
    try {
      setText(get(op.i), String(op.text ?? ''));
    } catch (e) {
      errors.push({ op, message: e.message });
    }
  }

  // 2. insertions (préparées, écrites à l'étape 5)
  const inserted = new Map(); // index d'ancre -> [objets]
  let model;
  for (const l of lines) if (l?.o?.type === 'assistant' && l.o.message?.model) model = l.o.message.model;
  for (const op of ops.filter((x) => x.op === 'insert_after')) {
    try {
      const anchor = lines[op.i];
      if (!anchor?.o || !CONVERSATIONAL.has(anchor.o.type)) throw new Error('Insertion possible seulement après un message user/assistant');
      const n = (inserted.get(op.i) ?? []).length;
      const prev = n ? inserted.get(op.i)[n - 1] : anchor.o;
      const uuid = crypto.randomUUID();
      const base = {
        parentUuid: prev.uuid,
        ...common(anchor),
        uuid,
        timestamp: plusMs(anchor.o.timestamp, n + 1),
        editedBy: 'claude-sessions',
      };
      const textBlock = [{ type: 'text', text: String(op.text ?? '') }];
      const o =
        op.role === 'assistant'
          ? {
              ...base,
              type: 'assistant',
              message: {
                id: `msg_edit_${crypto.randomBytes(12).toString('hex')}`,
                type: 'message',
                role: 'assistant',
                model: model ?? '<edited>',
                content: textBlock,
                stop_reason: 'end_turn',
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
              },
            }
          : { ...base, type: 'user', message: { role: 'user', content: textBlock } };
      if (!inserted.has(op.i)) inserted.set(op.i, []);
      inserted.get(op.i).push(o);
      byUuid.set(uuid, o);
    } catch (e) {
      errors.push({ op, message: e.message });
    }
  }
  // les anciens enfants de l'ancre pointent vers le dernier message inséré
  for (const [i, objs] of inserted) {
    const anchorUuid = lines[i].o.uuid;
    const last = objs[objs.length - 1].uuid;
    for (const l of lines) if (l?.o?.parentUuid === anchorUuid && CONVERSATIONAL.has(l.o.type)) l.o.parentUuid = last;
  }

  // 3. suppressions avec cascade appel <-> résultat
  const toDelete = new Set(ops.filter((x) => x.op === 'delete').map((x) => x.i));
  const toolUseOwner = new Map(); // tool_use id -> index de ligne assistant
  const toolResultOwner = new Map(); // tool_use id -> index de ligne user
  lines.forEach((l, i) => {
    const bs = l?.o ? blocks(l.o) : null;
    if (!bs) return;
    for (const b of bs) {
      if (l.o.type === 'assistant' && b.type === 'tool_use') toolUseOwner.set(b.id, i);
      if (l.o.type === 'user' && b.type === 'tool_result') toolResultOwner.set(b.tool_use_id, i);
    }
  });
  const dropBlocks = new Map(); // index -> Set(tool ids à retirer)
  const mark = (i, ids) => {
    if (!dropBlocks.has(i)) dropBlocks.set(i, new Set());
    for (const id of ids) dropBlocks.get(i).add(id);
  };
  for (const i of [...toDelete]) {
    const o = lines[i]?.o;
    const bs = o ? blocks(o) : null;
    if (!bs) continue;
    for (const b of bs) {
      if (b.type === 'tool_use' && toolResultOwner.has(b.id)) mark(toolResultOwner.get(b.id), [b.id]);
      if (b.type === 'tool_result' && toolUseOwner.has(b.tool_use_id)) mark(toolUseOwner.get(b.tool_use_id), [b.tool_use_id]);
    }
  }
  for (const [i, ids] of dropBlocks) {
    if (toDelete.has(i)) continue;
    const o = lines[i].o;
    const bs = blocks(o).filter((b) => !(b.type === 'tool_use' && ids.has(b.id)) && !(b.type === 'tool_result' && ids.has(b.tool_use_id)));
    if (bs.length === 0) toDelete.add(i);
    else o.message.content = bs;
  }
  const deletedUuids = new Set();
  for (const i of toDelete) if (lines[i]?.o?.uuid) deletedUuids.add(lines[i].o.uuid);
  const survivor = (uuid) => {
    const seen = new Set();
    let u = uuid;
    while (u && deletedUuids.has(u) && !seen.has(u)) {
      seen.add(u);
      u = byUuid.get(u)?.parentUuid ?? null;
    }
    return u ?? null;
  };
  // 4. recoudre la chaîne + leafUuid
  for (const [i, l] of lines.entries()) {
    if (!l?.o || toDelete.has(i)) continue;
    const o = l.o;
    if (o.parentUuid && deletedUuids.has(o.parentUuid)) o.parentUuid = survivor(o.parentUuid);
    if (o.leafUuid && deletedUuids.has(o.leafUuid)) o.leafUuid = survivor(o.leafUuid);
    if (o.sourceToolAssistantUUID && deletedUuids.has(o.sourceToolAssistantUUID)) delete o.sourceToolAssistantUUID;
  }
  for (const objs of inserted.values()) for (const o of objs) if (o.parentUuid && deletedUuids.has(o.parentUuid)) o.parentUuid = survivor(o.parentUuid);

  // 5. sortie
  const out = [];
  lines.forEach((l, i) => {
    if (!l) return;
    if (!toDelete.has(i)) out.push(l.raw ?? JSON.stringify(l.o));
    for (const o of inserted.get(i) ?? []) out.push(JSON.stringify(o));
  });
  return { text: out.join('\n') + '\n', errors, deleted: toDelete.size, inserted: [...inserted.values()].reduce((a, v) => a + v.length, 0) };
}
