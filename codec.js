// 문자셋·줄 구분 판별과 저장용 변환(브라우저 전용 API 없이 동작 — Node 단위 테스트 가능).
// 편집 중에는 줄바꿈을 항상 "\n" 으로 다루고, 저장할 때만 고른 줄 구분으로 바꾼다.

export const LINE_ENDINGS = [
  { id: 'crlf', seq: '\r\n', title: 'Windows (CRLF)', short: 'CRLF' },
  { id: 'lf', seq: '\n', title: 'Unix (LF)', short: 'LF' },
  { id: 'cr', seq: '\r', title: 'Macintosh (CR)', short: 'CR' },
];

export const ENCODINGS = [
  { id: 'utf8', title: 'UTF-8', bom: [] },
  { id: 'utf8bom', title: 'UTF-8 (BOM)', bom: [0xef, 0xbb, 0xbf] },
  { id: 'utf16le', title: 'UTF-16 LE', bom: [0xff, 0xfe] },
  { id: 'utf16be', title: 'UTF-16 BE', bom: [0xfe, 0xff] },
  { id: 'cp949', title: 'ANSI (EUC-KR / CP949)', bom: [] },
];

// 새 문서 기본값 — PC 메모장(Windows 11)과 같은 UTF-8 + CRLF
export const DEFAULT_ENCODING = 'utf8';
export const DEFAULT_LINE_ENDING = 'crlf';

export function encodingInfo(id) {
  return ENCODINGS.find((e) => e.id === id) || ENCODINGS[0];
}
export function lineEndingInfo(id) {
  return LINE_ENDINGS.find((e) => e.id === id) || LINE_ENDINGS[0];
}

export class UnencodableError extends Error {
  constructor(encoding, char) {
    super(`${encodingInfo(encoding).title} 문자셋으로 저장할 수 없는 글자("${char}")가 들어 있습니다.`);
    this.name = 'UnencodableError';
    this.encoding = encoding;
    this.char = char;
  }
}

function startsWith(bytes, prefix) {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false;
  return true;
}

function decodeWith(label, bytes, fatal) {
  return new TextDecoder(label, { fatal }).decode(bytes);
}

/** 가장 많이 쓰인 줄바꿈 방식 id. 줄바꿈이 없으면 null. */
export function detectLineEnding(raw) {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  const n = raw.length;
  for (let i = 0; i < n; i++) {
    const c = raw.charCodeAt(i);
    if (c === 13) {
      if (i + 1 < n && raw.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else {
        cr++;
      }
    } else if (c === 10) {
      lf++;
    }
  }
  if (crlf === 0 && lf === 0 && cr === 0) return null;
  if (crlf >= lf && crlf >= cr) return 'crlf';
  if (lf >= cr) return 'lf';
  return 'cr';
}

export function normalizeLineEndings(raw) {
  if (raw.indexOf('\r') === -1) return raw;
  return raw.replace(/\r\n?/g, '\n');
}

function finish(raw, encoding, lossy) {
  return {
    text: normalizeLineEndings(raw),
    encoding,
    lineEnding: detectLineEnding(raw) || DEFAULT_LINE_ENDING,
    lossy,
  };
}

/** 파일 바이트를 읽어 문자셋·줄 구분을 판별한다. */
export function decode(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) {
    const body = bytes.subarray(3);
    try {
      return finish(decodeWith('utf-8', body, true), 'utf8bom', false);
    } catch {
      return finish(decodeWith('utf-8', body, false), 'utf8bom', true);
    }
  }
  if (startsWith(bytes, [0xff, 0xfe])) {
    return finish(decodeWith('utf-16le', bytes.subarray(2), false), 'utf16le', false);
  }
  if (startsWith(bytes, [0xfe, 0xff])) {
    return finish(decodeWith('utf-16be', bytes.subarray(2), false), 'utf16be', false);
  }
  if (bytes.length === 0) {
    return { text: '', encoding: DEFAULT_ENCODING, lineEnding: DEFAULT_LINE_ENDING, lossy: false };
  }
  try {
    return finish(decodeWith('utf-8', bytes, true), 'utf8', false);
  } catch {
    /* UTF-8 이 아님 → 한국어 Windows ANSI(CP949) 시도 */
  }
  try {
    const s = decodeWith('euc-kr', bytes, false);
    if (s.indexOf('�') === -1) return finish(s, 'cp949', false);
  } catch {
    /* 이 브라우저가 euc-kr 을 모르면 아래로 */
  }
  return finish(decodeWith('utf-8', bytes, false), 'utf8', true);
}

/** 원본 바이트를 지정한 문자셋으로 다시 읽는다("이 문자셋으로 다시 읽기"). 읽을 수 없으면 null. */
export function decodeAs(input, encoding) {
  let bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const bom = encodingInfo(encoding).bom;
  if (bom.length && startsWith(bytes, bom)) bytes = bytes.subarray(bom.length);
  try {
    let s;
    switch (encoding) {
      case 'utf8':
      case 'utf8bom':
        s = decodeWith('utf-8', bytes, true);
        break;
      case 'utf16le':
        if (bytes.length % 2) return null;
        s = decodeWith('utf-16le', bytes, true);
        break;
      case 'utf16be':
        if (bytes.length % 2) return null;
        s = decodeWith('utf-16be', bytes, true);
        break;
      case 'cp949':
        s = decodeWith('euc-kr', bytes, false);
        if (s.indexOf('�') !== -1) return null;
        break;
      default:
        return null;
    }
    return finish(s, encoding, false);
  } catch {
    return null;
  }
}

// ── 저장 ──────────────────────────────────────────────────────────────

let cp949Table = null;

/** CP949 인코딩 표: 브라우저의 euc-kr 디코더로 2바이트 조합을 모두 풀어 거꾸로 만든다(처음 한 번, 약 수십 ms). */
function getCp949Table() {
  if (cp949Table) return cp949Table;
  const table = new Map();
  const decoder = new TextDecoder('euc-kr');
  const pair = new Uint8Array(2);
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x41; trail <= 0xfe; trail++) {
      pair[0] = lead;
      pair[1] = trail;
      const s = decoder.decode(pair);
      if (s.length !== 1) continue;
      const code = s.charCodeAt(0);
      if (code < 0x80 || code === 0xfffd) continue;
      if (!table.has(code)) table.set(code, (lead << 8) | trail);
    }
  }
  cp949Table = table;
  return table;
}

function encodeUtf16(text, littleEndian) {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (littleEndian) {
      out[i * 2] = c & 0xff;
      out[i * 2 + 1] = c >> 8;
    } else {
      out[i * 2] = c >> 8;
      out[i * 2 + 1] = c & 0xff;
    }
  }
  return out;
}

function encodeCp949(text) {
  const table = getCp949Table();
  const out = new Uint8Array(text.length * 2);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) {
      out[n++] = c;
      continue;
    }
    const v = table.get(c);
    if (v === undefined) {
      const cp = text.codePointAt(i);
      throw new UnencodableError('cp949', String.fromCodePoint(cp));
    }
    out[n++] = v >> 8;
    out[n++] = v & 0xff;
  }
  return out.subarray(0, n);
}

/** 편집 텍스트("\n") → 저장 바이트. 문자셋으로 표현할 수 없는 글자가 있으면 UnencodableError. */
export function encode(text, encoding, lineEnding) {
  const normalized = normalizeLineEndings(text);
  const seq = lineEndingInfo(lineEnding).seq;
  const converted = seq === '\n' ? normalized : normalized.replace(/\n/g, seq);
  let body;
  switch (encoding) {
    case 'utf16le':
      body = encodeUtf16(converted, true);
      break;
    case 'utf16be':
      body = encodeUtf16(converted, false);
      break;
    case 'cp949':
      body = encodeCp949(converted);
      break;
    default:
      body = new TextEncoder().encode(converted);
  }
  const bom = encodingInfo(encoding).bom;
  if (!bom.length) return body;
  const out = new Uint8Array(bom.length + body.length);
  out.set(bom, 0);
  out.set(body, bom.length);
  return out;
}

export function canEncode(text, encoding) {
  if (encoding !== 'cp949') return true;
  try {
    encodeCp949(text);
    return true;
  } catch {
    return false;
  }
}
