import type { CloneResult, SessionData, Source } from './types';

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
  remove: (key: string) => fetch(`/api/sessions/${key}`, { method: 'DELETE' }).then((r) => j<{ ok: true }>(r)),
  downloadUrl: (key: string) => `/api/sessions/${key}/download`,
};
