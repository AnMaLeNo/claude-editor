export type Kind = 'prompt' | 'assistant' | 'thinking' | 'tool_use' | 'tool_result' | 'system' | 'context' | 'summary' | 'meta';

export interface ToolRef {
  id: string;
  name: string;
  input?: unknown;
  useUuid?: string;
  useIndex?: number;
  isError?: boolean;
}

export interface Entry {
  i: number;
  bytes: number;
  type: string;
  subtype?: string;
  kind: Kind;
  uuid?: string;
  parentUuid: string | null;
  ts?: string;
  sidechain: boolean;
  agentId?: string;
  promptId?: string;
  turn: number;
  title: string;
  text: string;
  heavy: boolean;
  fullChars?: number;
  tools?: ToolRef[];
  isError?: boolean;
  result?: { durationMs?: number; interrupted?: boolean; filePath?: string; url?: string; stderr?: string };
  permission?: string;
  permissionMode?: string;
  origin?: string;
  model?: string;
  msgId?: string;
  stopReason?: string;
  usage?: Record<string, unknown>;
  thinking?: string;
  level?: string;
  leafUuid?: string;
  // état d'édition (côté client uniquement)
  edited?: boolean;
  deleted?: boolean;
  inserted?: boolean;
  insertId?: string;
}

export type EditOp =
  | { op: 'set_text'; i: number; text: string }
  | { op: 'delete'; i: number }
  | { op: 'insert_after'; i: number; role: 'user' | 'assistant'; text: string; id: string };

export interface EditResult {
  source: Source;
  newSessionId?: string;
  deleted: number;
  inserted: number;
  resumeByPath: string;
  resumeById?: string;
}

export interface Stats {
  lines: number;
  bytes: number;
  byKind: Record<Kind, number>;
  tools: Record<string, number>;
  errors: number;
  sidechain: number;
  turns: number;
  compactions: number;
  models: string[];
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; thinking: number; apiCalls: number };
  cost?: { totalCostUSD?: number; totalDuration?: number; linesAdded?: number; linesRemoved?: number };
  first?: string;
  last?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  entrypoint?: string;
  title?: string;
  firstPrompt?: string;
  forkedFrom?: string;
}

export interface Source {
  key: string;
  path: string;
  group: 'local' | 'uploads' | 'clones';
  project?: string;
  fileName: string;
  fileId: string;
  size: number;
  mtime: string;
  writable: boolean;
  idMismatch: boolean;
  lines?: number;
  turns?: number;
  title?: string;
  firstPrompt?: string;
  first?: string;
  last?: string;
  cwd?: string;
  gitBranch?: string;
  sessionId?: string;
  version?: string;
  forkedFrom?: string;
  sidechain?: number;
  error?: string;
}

export interface SessionData {
  source: Source;
  stats: Stats;
  entries: Entry[];
  parseErrors: { i: number; message: string; preview: string }[];
}

export interface CloneResult {
  source: Source;
  oldSessionId?: string;
  newSessionId: string;
  resumeById?: string;
  resumeByPath: string;
}

export const KIND_INFO: Record<Kind, { label: string; color: string; help: string }> = {
  prompt: { label: 'Prompts', color: '#4f8cff', help: 'Ce que tu as tapé (ou envoyé) à Claude. Ouvre un nouveau tour.' },
  assistant: { label: 'Réponses', color: '#3ecf8e', help: 'Texte écrit par Claude à ton intention.' },
  thinking: { label: 'Réflexion', color: '#b98cff', help: 'Raisonnement interne du modèle (souvent masqué/vide dans le fichier).' },
  tool_use: { label: 'Appels d\'outils', color: '#ff9f43', help: 'Claude lance un outil : Bash, Read, Edit, Grep, Agent, MCP…' },
  tool_result: { label: 'Résultats d\'outils', color: '#f6d365', help: 'Sortie renvoyée par l\'outil (rouge si erreur).' },
  system: { label: 'Système', color: '#ff6b6b', help: 'Événements de Claude Code : compaction, erreurs API, snapshots de fichiers…' },
  context: { label: 'Contexte injecté', color: '#2ec4b6', help: 'System-reminders ajoutés automatiquement : environnement, date, skills, prompt système…' },
  summary: { label: 'Résumés / titres', color: '#f78fb3', help: 'Titre de session, résumé de compaction.' },
  meta: { label: 'Technique', color: '#8d99ae', help: 'Lignes internes : file d\'attente, requêtes API, coût, dernier prompt…' },
};

export interface AiSettings {
  jevModel: string;
  hasOpenrouterKey?: boolean;
  openrouterApiKey?: string;
  claudePath: string;
  model: string;
  effort: '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  extraEnv: Record<string, string>;
  searchMaxTurns: number;
  timeoutSec: number;
  editConcurrency: number;
}

export interface AiHit {
  line: number;
  i: number;
  p: number;
  score: number;
  confidence: number;
}

export interface AiSearchResult {
  hits: AiHit[];
  costUSD: number;
  inputTokens: number;
  batches: number;
  scanned: number;
  model: string;
  scale: string[];
  scope: string;
  type: string;
}

export interface AiRoutes {
  scopes: Record<string, { label: string; desc: string }>;
  types: Record<string, { label: string; desc: string; scale: string[] }>;
}

export interface AiRoute {
  scope: string;
  type: string;
  scopeP: Record<string, number>;
  typeP: Record<string, number>;
  costUSD: number;
}

export interface AiEditItem {
  ref: string;
  ok: boolean;
  text?: string;
  error?: string;
  costUSD?: number;
  durationMs?: number;
  model?: string;
}

export type HarmonizeRole = 'user' | 'assistant' | 'tool_call' | 'tool_result';

export interface HarmonizeItem {
  ref: string;
  ok: boolean;
  text?: string;
  changed?: boolean;
  error?: string;
  costUSD?: number;
  contextMessages?: number;
}

export interface Job<T> {
  id: string;
  status: 'running' | 'done' | 'error';
  progress: unknown[];
  result?: T;
  error?: string;
  startedAt: number;
  endedAt?: number;
}
