import type { ReactNode } from 'react';

export function buildRegex(q: string, opts: { regex: boolean; caseSensitive: boolean; word: boolean }): RegExp | null {
  if (!q.trim()) return null;
  let src = opts.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (opts.word) src = `\\b(?:${src})\\b`;
  try {
    return new RegExp(src, opts.caseSensitive ? 'g' : 'gi');
  } catch {
    return null;
  }
}

export function highlight(text: string, re: RegExp | null): ReactNode {
  if (!re) return text;
  const out: ReactNode[] = [];
  let last = 0;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text)) && n < 500) {
    if (m[0] === '') {
      re.lastIndex++;
      continue;
    }
    out.push(text.slice(last, m.index));
    out.push(<mark key={n++}>{m[0]}</mark>);
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

export function countMatches(text: string, re: RegExp | null): number {
  if (!re) return 0;
  re.lastIndex = 0;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0] === '') re.lastIndex++;
    n++;
    if (n > 10000) break;
  }
  return n;
}
