// 찾기·바꾸기 순수 로직. 위치는 모두 JS 문자열 인덱스(UTF-16 단위) — textarea 의 selectionStart 와 같다.
// 찾을 말은 정규식이 아니라 "글자 그대로" 비교한다({{user}}, (a+b)*c, $1, \n 같은 기호도 그대로 찾고 바꾼다).

export const HIGHLIGHT_LIMIT = 5000;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeRegex(query, options) {
  return new RegExp(escapeRegExp(query), options.caseSensitive ? 'g' : 'gi');
}

/** 모든 일치 [{start, end}] (limit 개까지) */
export function allMatches(text, query, options, limit = Infinity) {
  const out = [];
  if (!query || !text) return out;
  const re = makeRegex(query, options);
  let m;
  while (out.length < limit && (m = re.exec(text)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

export function countMatches(text, query, options) {
  if (!query || !text) return 0;
  const re = makeRegex(query, options);
  let n = 0;
  while (re.exec(text) !== null) n++;
  return n;
}

function firstFrom(text, query, options, from) {
  const re = makeRegex(query, options);
  re.lastIndex = from;
  const m = re.exec(text);
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

function lastBefore(text, query, options, before) {
  // before 보다 앞에서 "끝나는" 마지막 일치
  const re = makeRegex(query, options);
  let found = null;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index + m[0].length > before) break;
    found = { start: m.index, end: m.index + m[0].length };
  }
  return found;
}

/**
 * selection({start,end}) 다음(forward) 또는 이전(backward)의 가장 가까운 일치.
 * wrapAround 이면 끝에서 처음으로(처음에서 끝으로) 돌아가 찾는다.
 */
export function find(text, query, selection, direction, options) {
  if (!query || !text) return null;
  const start = Math.max(0, Math.min(selection.start, text.length));
  const end = Math.max(start, Math.min(selection.end, text.length));
  if (direction === 'forward') {
    const found = firstFrom(text, query, options, end);
    if (found) return found;
    return options.wrapAround ? firstFrom(text, query, options, 0) : null;
  }
  const found = lastBefore(text, query, options, start);
  if (found) return found;
  return options.wrapAround ? lastBefore(text, query, options, text.length) : null;
}

export function isMatch(text, range, query, options) {
  if (!query || range.end <= range.start) return false;
  const piece = text.slice(range.start, range.end);
  return new RegExp(`^${escapeRegExp(query)}$`, options.caseSensitive ? '' : 'i').test(piece);
}

/** 단일 바꾸기 대상: 지금 선택이 일치하는 글자면 그것, 아니면 커서에서 direction 쪽으로 가장 가까운 일치. */
export function replaceTarget(text, query, selection, direction, options) {
  if (isMatch(text, selection, query, options)) return { start: selection.start, end: selection.end };
  const caret = direction === 'forward' ? selection.start : selection.end;
  return find(text, query, { start: caret, end: caret }, direction, options);
}

/** 모두 바꾸기 → {text, count}. 바꿀 말은 글자 그대로($1·$& 같은 치환 기호 해석 안 함). */
export function replaceAll(text, query, replacement, options) {
  const ranges = allMatches(text, query, options);
  if (!ranges.length) return { text, count: 0 };
  const parts = [];
  let cursor = 0;
  for (const r of ranges) {
    parts.push(text.slice(cursor, r.start), replacement);
    cursor = r.end;
  }
  parts.push(text.slice(cursor));
  return { text: parts.join(''), count: ranges.length };
}

// ── 줄·열 ─────────────────────────────────────────────────────────────

/** 1부터 시작하는 줄·열(열은 사람이 보는 글자 수 — 이모지 하나 = 1). */
export function lineAndColumn(text, index) {
  const i = Math.max(0, Math.min(index, text.length));
  let line = 1;
  let lineStart = 0;
  let p = text.indexOf('\n');
  while (p !== -1 && p < i) {
    line++;
    lineStart = p + 1;
    p = text.indexOf('\n', lineStart);
  }
  const column = Array.from(text.slice(lineStart, i)).length + 1;
  return { line, column };
}

export function lineCount(text) {
  if (!text) return 1;
  let n = 1;
  let p = text.indexOf('\n');
  while (p !== -1) {
    n++;
    p = text.indexOf('\n', p + 1);
  }
  return n;
}

export function charCount(text) {
  // 사람이 보는 글자 수(줄바꿈 제외)
  let n = 0;
  for (const ch of text) if (ch !== '\n') n++;
  return n;
}

/** "모두 찾기" 목록: [{start,end,line,snippet,matchStart,matchEnd}] */
export function hits(text, ranges, snippetLimit = 160) {
  const out = [];
  let line = 1;
  let scanned = 0;
  for (const r of ranges) {
    let p = text.indexOf('\n', scanned);
    while (p !== -1 && p < r.start) {
      line++;
      p = text.indexOf('\n', p + 1);
    }
    scanned = r.start;
    let ls = text.lastIndexOf('\n', r.start - 1) + 1;
    let le = text.indexOf('\n', r.start);
    if (le === -1) le = text.length;
    if (le - ls > snippetLimit) {
      ls = Math.max(ls, r.start - Math.floor(snippetLimit / 2));
      le = Math.min(le, ls + snippetLimit);
    }
    const raw = text.slice(ls, le);
    const lead = raw.length - raw.replace(/^[ \t]+/, '').length;
    const snippet = raw.trim();
    let matchStart = r.start - ls - lead;
    let matchEnd = matchStart + (r.end - r.start);
    if (matchStart < 0 || matchEnd > snippet.length) {
      matchStart = -1;
      matchEnd = -1;
    }
    out.push({ start: r.start, end: r.end, line, snippet, matchStart, matchEnd });
  }
  return out;
}

/** 읽기 모드 단락(=한 줄) 범위. 빈 줄이면 null. */
export function paragraphRange(text, index) {
  if (!text) return null;
  const i = Math.max(0, Math.min(index, text.length - 1));
  const start = text.lastIndexOf('\n', i - 1) + 1;
  let end = text.indexOf('\n', i);
  if (end === -1) end = text.length;
  if (text[i] === '\n' && i === start) return null;
  if (!text.slice(start, end).trim()) return null;
  return { start, end };
}

/** 파일 이름 정리: 금지 문자 치환, 빈 이름 → 제목 없음, 확장자 없으면 .txt */
export function sanitizeFileName(raw) {
  let name = String(raw || '').trim().replace(/[/\\:*?"<>|]/g, '-');
  while (name.startsWith('.')) name = name.slice(1);
  if (!name) name = '제목 없음';
  if (!/\.[^.\s]{1,8}$/.test(name)) name += '.txt';
  return name;
}
