import type { AiSettings, CloneResult, EditOp, EditResult, Job, SessionData, Source } from './types';

async function j<T>(r: Response): Promise<T> {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${r.status}`);
  return data as T;
}

export const api = {
  config: () => fetch('/api/config').then((r) => j<{ claudeDir: string; projectsDir: string; dataDir: string; platform: string }>(r)),
  sessions: () => fetch('/api/sessions').then((r) => j<{ sessions: Source[] }>(r)),
  session: (key: string) => fetch(`/api/sessions/${key}`).then((r) => j<SessionData>(r)),
  line: (key: string, i: number) => fetch(`/api/sessions/${key}/line/${i}`).then((r) => j<unknown>(r)),
  upload: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return fetch('/api/upload', { method: 'POST', body: fd }).then((r) => j<{ source: Source; parseErrors: number; truncated: boolean }>(r));
  },
  clone: (key: string, body: { dest: 'same' | 'workspace'; title?: string }) =>
    fetch(`/api/sessions/${key}/clone`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => j<CloneResult>(r)),
  edit: (key: string, body: { ops: EditOp[]; dest: 'inplace' | 'clone'; title?: string; cloneDest?: 'same' | 'workspace' }) =>
    fetch(`/api/sessions/${key}/edit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => j<EditResult>(r)),
  settings: () => fetch('/api/settings').then((r) => j<AiSettings>(r)),
  saveSettings: (s: Partial<AiSettings>) => fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s) }).then((r) => j<AiSettings>(r)),
  aiSearch: (key: string, query: string, includeMeta: boolean) =>
    fetch(`/api/sessions/${key}/ai-search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, includeMeta }) }).then((r) => j<{ jobId: string }>(r)),
  aiEdit: (items: { ref: string; text: string }[], instruction: string) =>
    fetch('/api/ai-edit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items, instruction }) }).then((r) => j<{ jobId: string }>(r)),
  job: <T>(id: string) => fetch(`/api/jobs/${id}`).then((r) => j<Job<T>>(r)),
  waitJob: async <T>(id: string, onProgress?: (p: unknown[]) => void, intervalMs = 1500): Promise<T> => {
    for (;;) {
      const job = await api.job<T>(id);
      onProgress?.(job.progress);
      if (job.status === 'done') return job.result as T;
      if (job.status === 'error') throw new Error(job.error ?? 'Erreur');
      await new Promise((res) => setTimeout(res, intervalMs));
    }
  },
  remove: (key: string) => fetch(`/api/sessions/${key}`, { method: 'DELETE' }).then((r) => j<{ ok: true }>(r)),
  downloadUrl: (key: string) => `/api/sessions/${key}/download`,
};
