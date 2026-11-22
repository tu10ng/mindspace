const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

const DOT_KEY = /^\.([A-Za-z_$][A-Za-z0-9_$]*)/;
const BRACKET = /^\[(\d+)\]|^\["((?:[^"\\]|\\.)*)"\]|^\['((?:[^'\\]|\\.)*)'\]/;
const FIRST = /^([A-Za-z_$][A-Za-z0-9_$]*)/;

export type PathSegment = { kind: 'key'; key: string } | { kind: 'index'; index: number };

function pushBracket(m: RegExpExecArray, segments: PathSegment[]): boolean {
  if (m[1] !== undefined) {
    segments.push({ kind: 'index', index: Number(m[1]) });
  } else if (m[2] !== undefined) {
    segments.push({ kind: 'key', key: m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\') });
  } else if (m[3] !== undefined) {
    segments.push({ kind: 'key', key: m[3].replace(/\\'/g, "'").replace(/\\\\/g, '\\') });
  } else {
    return false;
  }
  return true;
}

export function parsePath(path: string): { segments: PathSegment[] } | { error: string } {
  let rest = path;
  const segments: PathSegment[] = [];
  const first = FIRST.exec(rest);
  if (first === null) {
    const bracket = BRACKET.exec(rest);
    if (bracket === null || !pushBracket(bracket, segments)) {
      return { error: `invalid path start: "${path}"` };
    }
    rest = rest.slice(bracket[0].length);
  } else {
    segments.push({ kind: 'key', key: first[1] ?? '' });
    rest = rest.slice(first[0].length);
  }
  while (rest.length > 0) {
    const dot = DOT_KEY.exec(rest);
    if (dot !== null) {
      segments.push({ kind: 'key', key: dot[1] ?? '' });
      rest = rest.slice(dot[0].length);
      continue;
    }
    const bracket = BRACKET.exec(rest);
    if (bracket === null || !pushBracket(bracket, segments)) {
      return { error: `invalid path segment at "${rest}" in "${path}"` };
    }
    rest = rest.slice(bracket[0].length);
  }
  return { segments };
}

export function checkPath(path: string): string | null {
  const parsed = parsePath(path);
  if ('error' in parsed) {
    return parsed.error;
  }
  for (const seg of parsed.segments) {
    if (seg.kind === 'key' && FORBIDDEN.has(seg.key)) {
      return `forbidden path segment: "${seg.key}"`;
    }
  }
  return null;
}

export function resolvePath(root: unknown, path: string): unknown {
  if (checkPath(path) !== null) {
    return undefined;
  }
  const parsed = parsePath(path);
  if ('error' in parsed) {
    return undefined;
  }
  let current: unknown = root;
  for (const seg of parsed.segments) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    if (seg.kind === 'index') {
      if (!Array.isArray(current)) {
        return undefined;
      }
      current = current[seg.index];
    } else {
      if (!Object.prototype.hasOwnProperty.call(current, seg.key)) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[seg.key];
    }
  }
  return current;
}
