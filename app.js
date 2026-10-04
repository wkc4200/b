import * as codec from './codec.js';
import * as S from './search.js';
import { UndoHistory } from './history.js';
import * as store from './store.js';

// ── 준비 ───────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const el = {
  home: $('home'),
  editor: $('editor'),
  recent: $('recent'),
  installTip: $('install-tip'),
  homeNew: $('home-new'),
  homeOpen: $('home-open'),
  fileInput: $('file-input'),
  docName: $('doc-name'),
  docSub: $('doc-sub'),
  btnExit: $('btn-exit'),
  btnFindTop: $('btn-find-top'),
  btnMode: $('btn-mode'),
  toolbar: $('toolbar'),
  tbNew: $('tb-new'),
  tbOpen: $('tb-open'),
  tbSave: $('tb-save'),
  tbSaveAs: $('tb-saveas'),
  tbUndo: $('tb-undo'),
  tbRedo: $('tb-redo'),
  tbFind: $('tb-find'),
  tbReplace: $('tb-replace'),
  findbar: $('findbar'),
  findInput: $('find-input'),
  findCount: $('find-count'),
  findPrev: $('find-prev'),
  findNext: $('find-next'),
  findAll: $('find-all'),
  optCase: $('opt-case'),
  optWrap: $('opt-wrap'),
  replaceToggleWrap: $('replace-toggle-wrap'),
  replaceToggle: $('replace-toggle'),
  findClose: $('find-close'),
  replaceRow: $('replace-row'),
  replaceInput: $('replace-input'),
  repUp: $('rep-up'),
  repDown: $('rep-down'),
  repAll: $('rep-all'),
  doc: $('doc'),
  backdrop: $('backdrop'),
  text: $('text'),
  reader: $('reader'),
  paraBar: $('para-bar'),
  paraCopy: $('para-copy'),
  paraClose: $('para-close'),
  stPos: $('st-pos'),
  stCount: $('st-count'),
  zoomOut: $('zoom-out'),
  zoomReset: $('zoom-reset'),
  zoomIn: $('zoom-in'),
  stEol: $('st-eol'),
  stEnc: $('st-enc'),
};

const isIOS =
  /iP(ad|hone|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone =
  (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;

const LARGE_FILE = 15 * 1024 * 1024;
const UNTITLED = '제목 없음.txt';

const state = {
  view: 'home',
  doc: null, // { id, name, isNew, encoding, lineEnding, originalBytes, lossy }
  mode: 'read',
  dirty: false,
  zoom: Number(store.loadSetting('zoom', 1)) || 1,
  find: {
    open: false,
    options: { caseSensitive: false, wrapAround: true },
    matches: [],
    total: 0,
    current: null,
  },
  lines: [],
  lineStarts: [0],
  markedLines: new Set(),
  paragraph: null,
};

const undoHistory = new UndoHistory();
let lastValue = '';
let pendingSel = null;
let composing = false;

// ── 작은 도구 ───────────────────────────────────────────────────────────

function debounce(fn, ms) {
  let t = 0;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  wrapped.now = (...args) => {
    clearTimeout(t);
    fn(...args);
  };
  return wrapped;
}

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHTML(s) {
  return s.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

function toast(message) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = message;
  document.body.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity .3s';
    t.style.opacity = '0';
  }, 1700);
  setTimeout(() => t.remove(), 2100);
}

/**
 * 팝업. buttons: [{label, value, kind:'primary'|'danger', onClick}] — onClick 은 누른 순간 바로 실행된다
 * (파일 선택 창·공유 시트처럼 "사용자가 누른 순간"에만 열리는 기능을 위해).
 */
let dialogOpen = 0;
function dialog({ title, message, input, buttons, cancelValue = null, className = '' }) {
  return new Promise((resolve) => {
    dialogOpen++;
    const prevFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    const box = document.createElement('div');
    box.className = `dialog ${className}`;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    if (title) {
      const h = document.createElement('h2');
      h.textContent = title;
      box.appendChild(h);
    }
    if (message) {
      const p = document.createElement('p');
      p.textContent = message;
      box.appendChild(p);
    }
    let field = null;
    if (input) {
      field = document.createElement('input');
      field.className = 'field';
      field.type = 'text';
      field.value = input.value || '';
      field.setAttribute('autocomplete', 'off');
      field.setAttribute('autocorrect', 'off');
      field.setAttribute('autocapitalize', 'off');
      field.spellcheck = false;
      box.appendChild(field);
    }
    const row = document.createElement('div');
    row.className = 'buttons';
    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      dialogOpen--;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      // 팝업 전에 쓰던 칸(본문·찾기 칸)으로 커서를 돌려준다
      if (prevFocus && prevFocus !== document.body && prevFocus.isConnected && !prevFocus.closest('[hidden]') && document.activeElement !== el.fileInput) {
        try {
          prevFocus.focus({ preventScroll: true });
        } catch {
          /* 무시 */
        }
      }
      resolve(field && value !== cancelValue ? { value, input: field.value } : value);
    };
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn ${b.kind || ''}`;
      btn.textContent = b.label;
      btn.addEventListener('click', () => {
        if (b.onClick) b.onClick(field ? field.value : undefined);
        close(b.value);
      });
      row.appendChild(btn);
    }
    box.appendChild(row);
    if (input && input.extra) box.appendChild(input.extra);
    overlay.appendChild(box);
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay && cancelValue !== undefined) close(cancelValue);
    });
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(cancelValue);
      } else if (e.key === 'Enter' && !e.isComposing && field && document.activeElement === field) {
        e.preventDefault();
        const primary = buttons.find((b) => b.kind === 'primary');
        if (primary) {
          if (primary.onClick) primary.onClick(field.value);
          close(primary.value);
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    if (field) {
      field.focus();
      const dot = input.selectBase ? field.value.lastIndexOf('.') : -1;
      field.setSelectionRange(0, dot > 0 ? dot : field.value.length);
    } else {
      const primary = row.querySelector('.btn.primary') || row.lastElementChild;
      if (primary) primary.focus();
    }
  });
}

function alertDialog(title, message) {
  return dialog({ title, message, buttons: [{ label: '확인', value: true, kind: 'primary' }], cancelValue: true });
}

// ── 화면 전환 ───────────────────────────────────────────────────────────

function showHome() {
  state.view = 'home';
  el.editor.hidden = true;
  el.home.hidden = false;
  document.title = '메모장';
  renderRecent();
}

function showEditor() {
  state.view = 'editor';
  el.home.hidden = true;
  el.editor.hidden = false;
}

async function renderRecent() {
  const list = await store.listLibrary();
  el.recent.textContent = '';
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '아직 문서가 없습니다. [파일 열기]로 txt 파일을 열거나 [새로 만들기]를 눌러 보세요.';
    el.recent.appendChild(li);
    return;
  }
  const fmt = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  for (const item of list) {
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'open';
    open.innerHTML = '<svg><use href="#i-doc"/></svg><span><span class="name"></span><span class="meta"></span></span>';
    open.querySelector('.name').textContent = item.name;
    const size = item.size >= 1024 * 1024 ? `${(item.size / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(item.size / 1024))}KB`;
    open.querySelector('.meta').textContent = `${fmt.format(new Date(item.updatedAt))} · ${size} · ${codec.encodingInfo(item.encoding).title}`;
    open.addEventListener('click', () => openFromLibrary(item.id));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn icon';
    del.setAttribute('aria-label', `${item.name} 목록에서 지우기`);
    del.innerHTML = '<svg><use href="#i-x"/></svg>';
    del.addEventListener('click', async () => {
      const ok = await dialog({
        title: `"${item.name}"을(를) 목록에서 지울까요?`,
        message: '앱에 보관된 사본만 지워집니다. 파일 앱의 원본 파일은 그대로입니다.',
        buttons: [
          { label: '취소', value: false },
          { label: '지우기', value: true, kind: 'danger' },
        ],
        cancelValue: false,
      });
      if (ok) {
        await store.deleteLibrary(item.id);
        renderRecent();
      }
    });
    li.append(open, del);
    el.recent.appendChild(li);
  }
}

// ── 문서 열기 / 새로 만들기 / 닫기 ──────────────────────────────────────

function currentText() {
  return el.text.value;
}

function needsSavePrompt() {
  if (!state.doc || !state.dirty) return false;
  if (state.doc.isNew && currentText() === '') return false;
  return true;
}

function loadIntoEditor(text, mode, { dirty = false, selection = null, scrollTop = 0 } = {}) {
  closeParagraph();
  el.text.value = text;
  lastValue = text;
  undoHistory.clear();
  state.dirty = dirty;
  state.find.current = null;
  showEditor();
  setMode(mode, { keepScroll: false });
  if (selection) {
    try {
      el.text.setSelectionRange(selection.start, selection.end);
    } catch {
      /* 무시 */
    }
  } else {
    el.text.setSelectionRange(0, 0);
  }
  requestAnimationFrame(() => {
    if (state.mode === 'edit') el.text.scrollTop = scrollTop;
    else el.reader.scrollTop = scrollTop;
    syncBackdropScroll();
  });
  refreshAll();
  if (state.find.open) refreshMatches();
}

function newDocument() {
  state.doc = { id: uid(), name: UNTITLED, isNew: true, encoding: codec.DEFAULT_ENCODING, lineEnding: codec.DEFAULT_LINE_ENDING, originalBytes: null, lossy: false };
  loadIntoEditor('', 'edit');
  saveSessionSoon.now();
}

async function openBytes(name, bytes, { id = uid() } = {}) {
  const decoded = codec.decode(bytes);
  state.doc = { id, name, isNew: false, encoding: decoded.encoding, lineEnding: decoded.lineEnding, originalBytes: bytes, lossy: decoded.lossy };
  loadIntoEditor(decoded.text, 'read');
  // 최근 문서 목록(사본) — 보관함에서 다시 연 문서도 맨 위로 올린다
  await store.putLibrary({ id, name, bytes: bytes.slice().buffer, encoding: decoded.encoding, lineEnding: decoded.lineEnding, size: bytes.length, updatedAt: Date.now() });
  saveSessionSoon.now();
  if (decoded.lossy) {
    alertDialog('일부 글자를 읽지 못했습니다', '알 수 없는 문자셋이라 깨진 글자를 대체 문자(�)로 표시했습니다.\n아래 상태줄의 문자셋 메뉴 → "이 문자셋으로 다시 읽기"를 시도해 보세요.');
  }
}

async function handleFile(file) {
  if (!file) return;
  if (file.size > LARGE_FILE) {
    const ok = await dialog({
      title: '큰 파일입니다',
      message: `${(file.size / 1048576).toFixed(1)}MB 파일입니다. 여는 데 시간이 걸리고 편집이 느릴 수 있습니다. 계속할까요?`,
      buttons: [
        { label: '취소', value: false },
        { label: '열기', value: true, kind: 'primary' },
      ],
      cancelValue: false,
    });
    if (!ok) return;
  }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await openBytes(file.name || UNTITLED, bytes);
  } catch (e) {
    alertDialog('파일을 열 수 없습니다', `${file.name}\n${e && e.message ? e.message : e}`);
  }
}

async function openFromLibrary(id) {
  const item = await store.getLibrary(id);
  if (!item) {
    toast('문서를 찾을 수 없습니다');
    renderRecent();
    return;
  }
  await openBytes(item.name, new Uint8Array(item.bytes), { id: item.id });
}

/** 파일 선택 창 열기. 지금 문서에 저장 안 한 내용이 있으면 먼저 묻는다. */
function requestOpen() {
  if (state.view === 'editor' && needsSavePrompt()) {
    askSaveThen('open');
    return;
  }
  el.fileInput.click();
}

function requestNew() {
  if (state.view === 'editor' && needsSavePrompt()) {
    askSaveThen('new');
    return;
  }
  newDocument();
}

async function closeDocument() {
  state.doc = null;
  state.dirty = false;
  el.text.value = '';
  lastValue = '';
  undoHistory.clear();
  closeFind({ focus: false });
  closeParagraph();
  el.reader.textContent = '';
  saveSessionSoon.cancel();
  await store.clearSession();
  showHome();
}

/**
 * 저장 확인 팝업 → 예/아니오/취소.
 * after: 'exit' | 'open' | 'new'
 */
async function askSaveThen(after) {
  const name = state.doc.name;
  const title = state.doc.isNew ? `"${name}"을 저장할까요?` : `변경한 내용을 "${name}"에 저장할까요?`;
  const choice = await dialog({
    title,
    buttons: [
      { label: '취소', value: 'cancel' },
      {
        label: '아니오',
        value: 'no',
        kind: 'danger',
        // 파일 선택 창은 "누른 순간"에만 열 수 있어 여기서 바로 연다
        onClick: () => {
          if (after === 'open') el.fileInput.click();
        },
      },
      { label: '예', value: 'yes', kind: 'primary' },
    ],
    cancelValue: 'cancel',
  });
  if (choice === 'cancel') return false;
  if (choice === 'yes') {
    const saved = await saveDocument({ asNew: false });
    if (!saved) return false;
  }
  if (after === 'exit') {
    await closeDocument();
  } else if (after === 'new') {
    newDocument();
  } else if (after === 'open' && choice === 'yes') {
    await dialog({
      title: '저장했습니다',
      message: '열 파일을 고르세요.',
      buttons: [
        { label: '닫기', value: false },
        { label: '파일 고르기', value: true, kind: 'primary', onClick: () => el.fileInput.click() },
      ],
      cancelValue: false,
    });
  }
  return true;
}

function requestExit() {
  if (needsSavePrompt()) {
    askSaveThen('exit');
  } else {
    closeDocument();
  }
}

// ── 저장 ────────────────────────────────────────────────────────────────

const canUseShareSheet = isIOS || /Android/i.test(navigator.userAgent);

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/**
 * iPad: 공유 시트 → "파일에 저장"(폴더 선택·같은 이름이면 대치 확인은 iPadOS 가 처리). 그 외: 다운로드.
 * 공유 시트는 "사용자가 누른 순간"에만 열리므로, 이 함수는 버튼 클릭 처리 안에서 await 없이 바로 불러야 한다.
 * 결과: 'ok' | 'cancel' | 'retry'
 */
function shareOrDownload(file) {
  const canShare = canUseShareSheet && navigator.share && navigator.canShare && navigator.canShare({ files: [file] });
  if (!canShare) {
    downloadFile(file);
    return Promise.resolve('ok');
  }
  try {
    return navigator.share({ files: [file] }).then(
      () => 'ok',
      (e) => (e && e.name === 'AbortError' ? 'cancel' : 'retry'),
    );
  } catch {
    return Promise.resolve('retry');
  }
}

/** 지금 글을 인코딩해서 바로 내보내기 시작(동기적으로 공유 시트를 연다). */
function startDelivery(name) {
  const doc = state.doc;
  let bytes;
  try {
    bytes = codec.encode(currentText(), doc.encoding, doc.lineEnding);
  } catch (e) {
    if (e instanceof codec.UnencodableError) return Promise.resolve({ unencodable: e });
    return Promise.resolve({ error: e });
  }
  const file = new File([bytes], name, { type: 'text/plain' });
  return shareOrDownload(file).then((r) => ({ status: r, file, bytes }));
}

let saveHintShown = store.loadSetting('saveHintShown', false);

/** 저장 / 다른 이름으로 저장. 저장하면 true. */
async function saveDocument({ asNew }) {
  if (!state.doc) return false;
  const doc = state.doc;
  let name = doc.name;
  let delivery = null;
  const begin = (n) => {
    name = n;
    delivery = startDelivery(n);
  };

  if (asNew || doc.isNew) {
    const res = await dialog({
      title: asNew ? '다른 이름으로 저장' : '저장',
      message: canUseShareSheet
        ? '파일 이름을 입력하세요.\n다음 화면에서 "파일에 저장"을 눌러 저장할 폴더를 고릅니다.'
        : '파일 이름을 입력하세요.',
      input: { value: name, selectBase: true },
      buttons: [
        { label: '취소', value: false },
        { label: canUseShareSheet ? '다음' : '저장', value: true, kind: 'primary', onClick: (v) => begin(S.sanitizeFileName(v)) },
      ],
      cancelValue: false,
    });
    if (!res || !res.value || !delivery) return false;
  } else if (!saveHintShown && canUseShareSheet) {
    const go = await dialog({
      title: '저장 방법',
      message:
        '웹앱은 파일 원본에 직접 쓸 수 없어 공유 화면으로 저장합니다.\n"파일에 저장" → 원래 폴더에서 같은 이름으로 저장하면 iPad 가 "대치"할지 묻습니다. 대치를 누르면 원본이 바뀝니다.',
      buttons: [
        { label: '취소', value: false },
        { label: '계속', value: true, kind: 'primary', onClick: () => begin(name) },
      ],
      cancelValue: false,
    });
    if (!go || !delivery) return false;
    saveHintShown = true;
    store.saveSetting('saveHintShown', true);
  } else {
    begin(name);
  }

  let result = await delivery;

  if (result.unencodable) {
    const ok = await dialog({
      title: '이 문자셋으로 저장할 수 없습니다',
      message: `${result.unencodable.message}\nUTF-8 로 바꿔서 저장할까요?`,
      buttons: [
        { label: '취소', value: false },
        {
          label: 'UTF-8로 저장',
          value: true,
          kind: 'primary',
          onClick: () => {
            doc.encoding = 'utf8';
            renderStatusMenus();
            begin(name);
          },
        },
      ],
      cancelValue: false,
    });
    if (!ok) return false;
    result = await delivery;
  }
  if (result.error) {
    alertDialog('저장하지 못했습니다', String(result.error && result.error.message ? result.error.message : result.error));
    return false;
  }
  if (result.status === 'retry') {
    // 팝업을 거치느라 "누른 순간"이 지나 공유 화면이 안 열린 경우 → 버튼을 한 번 더
    const file = result.file;
    let again = null;
    const ok = await dialog({
      title: '저장 위치 고르기',
      message: '아래 버튼을 누르면 공유 화면이 열립니다. "파일에 저장"을 눌러 폴더를 고르세요.',
      buttons: [
        { label: '취소', value: false },
        { label: '파일에 저장', value: true, kind: 'primary', onClick: () => (again = shareOrDownload(file)) },
      ],
      cancelValue: false,
    });
    if (!ok || !again) return false;
    let status = await again;
    if (status === 'retry') {
      downloadFile(file);
      status = 'ok';
    }
    result = { ...result, status };
  }
  if (result.status !== 'ok') {
    toast('저장을 취소했습니다');
    return false;
  }

  doc.name = name;
  doc.isNew = false;
  doc.originalBytes = result.bytes;
  state.dirty = false;
  await store.putLibrary({
    id: doc.id,
    name,
    bytes: result.bytes.slice().buffer,
    encoding: doc.encoding,
    lineEnding: doc.lineEnding,
    size: result.bytes.length,
    updatedAt: Date.now(),
  });
  refreshTitle();
  renderStatusMenus();
  saveSessionSoon.now();
  toast(`"${name}" 저장`);
  return true;
}

// ── 모드 ────────────────────────────────────────────────────────────────

function firstVisibleLineIndexInReader() {
  const top = el.reader.scrollTop;
  const kids = el.reader.children;
  let lo = 0;
  let hi = kids.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (kids[mid].offsetTop + kids[mid].offsetHeight > top) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

function setMode(mode, { keepScroll = true } = {}) {
  const prev = state.mode;
  // 화면 위치 유지: 비율로 옮긴다
  let ratio = 0;
  if (keepScroll) {
    const src = prev === 'edit' ? el.text : el.reader;
    const max = src.scrollHeight - src.clientHeight;
    ratio = max > 0 ? src.scrollTop / max : 0;
  }
  let caretFromReader = null;
  if (keepScroll && prev === 'read' && mode === 'edit' && state.lines.length) {
    const i = firstVisibleLineIndexInReader();
    caretFromReader = state.lineStarts[i] || 0;
  }

  state.mode = mode;
  const editing = mode === 'edit';
  closeParagraph();
  el.text.hidden = !editing;
  el.backdrop.hidden = !editing;
  el.reader.hidden = editing;
  el.toolbar.hidden = !editing;
  el.replaceToggleWrap.hidden = !editing;
  if (!editing && el.replaceToggle.checked) {
    el.replaceToggle.checked = false;
    el.replaceRow.hidden = true;
  }
  el.btnMode.innerHTML = editing
    ? '<svg><use href="#i-book"/></svg><span>읽기 모드</span>'
    : '<svg><use href="#i-pencil"/></svg><span>편집</span>';
  el.btnMode.setAttribute('aria-label', editing ? '읽기 모드로 전환 (⌘E)' : '편집 모드로 전환 (⌘E)');

  if (!editing) renderReader();

  if (keepScroll) {
    const dst = editing ? el.text : el.reader;
    requestAnimationFrame(() => {
      const max = dst.scrollHeight - dst.clientHeight;
      dst.scrollTop = Math.round(ratio * Math.max(0, max));
      syncBackdropScroll();
    });
  }
  if (editing) {
    if (caretFromReader !== null) el.text.setSelectionRange(caretFromReader, caretFromReader);
    renderBackdrop();
    if (keepScroll) {
      const st = el.text.scrollTop;
      el.text.focus({ preventScroll: true });
      el.text.scrollTop = st;
    }
  } else if (document.activeElement === el.text) {
    el.text.blur();
  }
  renderHighlights();
  refreshTitle();
  renderStatusMenus();
  updateUndoButtons();
  updateStatus();
}

function toggleMode() {
  setMode(state.mode === 'edit' ? 'read' : 'edit');
  saveSessionSoon();
}

// ── 읽기 모드 ───────────────────────────────────────────────────────────

function renderReader() {
  const text = currentText();
  const lines = text.split('\n');
  state.lines = lines;
  const starts = new Array(lines.length);
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    starts[i] = pos;
    pos += lines[i].length + 1;
  }
  state.lineStarts = starts;
  state.markedLines = new Set();
  const frag = document.createDocumentFragment();
  for (let i = 0; i < lines.length; i++) {
    const d = document.createElement('div');
    d.className = 'p';
    d.dataset.i = String(i);
    d.textContent = lines[i];
    frag.appendChild(d);
  }
  el.reader.textContent = '';
  el.reader.appendChild(frag);
}

function lineIndexOf(pos) {
  const starts = state.lineStarts;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function onReaderClick(e) {
  if (state.mode !== 'read') return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && el.reader.contains(sel.anchorNode)) return; // 직접 글자를 고르는 중
  const p = e.target.closest('.p');
  if (!p) {
    closeParagraph();
    return;
  }
  const i = Number(p.dataset.i);
  if (!state.lines[i] || !state.lines[i].trim()) {
    closeParagraph();
    return;
  }
  if (state.paragraph === i) {
    closeParagraph();
    return;
  }
  closeParagraph();
  state.paragraph = i;
  p.classList.add('sel');
  positionParaBar();
}

function paragraphEl() {
  return state.paragraph === null ? null : el.reader.children[state.paragraph] || null;
}

function positionParaBar() {
  const p = paragraphEl();
  if (!p) return;
  el.paraBar.hidden = false;
  const barH = el.paraBar.offsetHeight;
  const barW = el.paraBar.offsetWidth;
  const top = p.offsetTop - el.reader.scrollTop;
  let y = top - barH - 8;
  if (y < 8) y = top + p.offsetHeight + 8;
  y = Math.min(y, el.doc.clientHeight - barH - 8);
  const x = Math.max(12, Math.min(p.offsetLeft, el.doc.clientWidth - barW - 12));
  el.paraBar.style.left = `${x}px`;
  el.paraBar.style.top = `${Math.max(8, y)}px`;
}

function closeParagraph() {
  const p = paragraphEl();
  if (p) p.classList.remove('sel');
  state.paragraph = null;
  el.paraBar.hidden = true;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

async function copyParagraph() {
  if (state.paragraph === null) return;
  const text = state.lines[state.paragraph] || '';
  const ok = await copyText(text);
  closeParagraph();
  toast(ok ? '단락을 복사했습니다' : '복사하지 못했습니다');
}

const repositionParaSoon = debounce(() => {
  if (state.paragraph !== null && state.mode === 'read') positionParaBar();
}, 140);

// ── 편집 기록(실행 취소) ─────────────────────────────────────────────────

function selectionNow() {
  return { start: el.text.selectionStart, end: el.text.selectionEnd };
}

function commitInput(merge) {
  const v = el.text.value;
  if (v === lastValue) return;
  undoHistory.record(lastValue, v, pendingSel, selectionNow(), { merge });
  lastValue = v;
  pendingSel = null;
  onTextChanged();
}

function applyValue(text, selection) {
  const st = el.text.scrollTop;
  el.text.value = text;
  lastValue = text;
  if (selection) {
    const s = Math.min(selection.start, text.length);
    const e = Math.min(selection.end, text.length);
    el.text.setSelectionRange(s, e);
  }
  el.text.scrollTop = st;
  onTextChanged();
  if (selection) ensureIndexVisible(selection.start);
}

/** 코드로 글자를 바꾼다(바꾸기·모두 바꾸기) — 실행 취소 한 번으로 되돌릴 수 있게 기록. */
function applyEdit(start, end, insert) {
  const before = el.text.value;
  const after = before.slice(0, start) + insert + before.slice(end);
  const selAfter = { start, end: start + insert.length };
  undoHistory.record(before, after, { start, end }, selAfter, { merge: false });
  const st = el.text.scrollTop;
  el.text.value = after;
  lastValue = after;
  el.text.setSelectionRange(selAfter.start, selAfter.end);
  el.text.scrollTop = st;
  onTextChanged();
}

function undo() {
  if (state.mode !== 'edit') return;
  const r = undoHistory.undo(el.text.value);
  if (!r) return;
  applyValue(r.text, r.selection);
}

function redo() {
  if (state.mode !== 'edit') return;
  const r = undoHistory.redo(el.text.value);
  if (!r) return;
  applyValue(r.text, r.selection);
}

function updateUndoButtons() {
  const editing = state.mode === 'edit';
  el.tbUndo.disabled = !(editing && undoHistory.canUndo);
  el.tbRedo.disabled = !(editing && undoHistory.canRedo);
}

function onTextChanged() {
  if (!state.dirty) {
    state.dirty = true;
    refreshTitle();
  }
  state.find.current = null;
  updateUndoButtons();
  updateStatusSoon();
  updateCountsSoon();
  if (state.find.open) refreshMatchesSoon();
  saveSessionSoon();
}

/** index 위치가 화면에 보이도록 편집 영역을 스크롤(뒤쪽 강조 레이어로 위치를 잰다). */
function ensureIndexVisible(index) {
  if (state.mode !== 'edit') return;
  const text = el.text.value;
  const probeHTML = `${escapeHTML(text.slice(0, index))}<span id="probe">​</span>`;
  el.backdrop.innerHTML = probeHTML;
  const probe = document.getElementById('probe');
  const y = probe ? probe.offsetTop : 0;
  renderBackdrop();
  const top = el.text.scrollTop;
  const h = el.text.clientHeight;
  if (y < top + 20 || y > top + h - 60) {
    el.text.scrollTop = Math.max(0, y - h * 0.35);
  }
  syncBackdropScroll();
}

// ── 찾기 / 바꾸기 ───────────────────────────────────────────────────────

function openFind({ replace = false } = {}) {
  closeParagraph();
  state.find.open = true;
  el.findbar.hidden = false;
  if (replace && state.mode === 'edit') {
    el.replaceToggle.checked = true;
    el.replaceRow.hidden = false;
  }
  // 고른 글자가 있으면 찾을 내용으로(한 줄짜리만)
  let selected = '';
  if (state.mode === 'edit') {
    const { start, end } = selectionNow();
    if (end > start && end - start < 200) selected = el.text.value.slice(start, end);
  } else {
    const s = window.getSelection();
    if (s && !s.isCollapsed && el.reader.contains(s.anchorNode)) selected = s.toString();
  }
  if (selected && selected.indexOf('\n') === -1) el.findInput.value = selected;
  const target = replace && state.mode === 'edit' && el.findInput.value ? el.replaceInput : el.findInput;
  target.focus();
  target.select();
  refreshMatches();
}

function closeFind({ focus = true } = {}) {
  if (!state.find.open && el.findbar.hidden) return;
  state.find.open = false;
  state.find.matches = [];
  state.find.total = 0;
  state.find.current = null;
  el.findbar.hidden = true;
  renderHighlights();
  if (focus && state.mode === 'edit') el.text.focus({ preventScroll: true });
}

function findQuery() {
  return el.findInput.value;
}

function refreshMatches() {
  const q = findQuery();
  const f = state.find;
  if (!f.open || !q) {
    f.matches = [];
    f.total = 0;
    f.current = null;
  } else {
    const text = currentText();
    f.matches = S.allMatches(text, q, f.options, S.HIGHLIGHT_LIMIT);
    f.total = f.matches.length < S.HIGHLIGHT_LIMIT ? f.matches.length : S.countMatches(text, q, f.options);
    if (f.current && !f.matches.some((m) => m.start === f.current.start && m.end === f.current.end)) f.current = null;
  }
  updateFindButtons();
  updateCount();
  renderHighlights();
}
const refreshMatchesSoon = debounce(refreshMatches, 160);

function updateFindButtons() {
  const has = !!findQuery();
  for (const b of [el.findPrev, el.findNext, el.findAll, el.repUp, el.repDown, el.repAll]) b.disabled = !has;
}

function updateCount() {
  const f = state.find;
  const q = findQuery();
  el.findCount.classList.remove('none');
  if (!q) {
    el.findCount.textContent = '';
    return;
  }
  if (f.total === 0) {
    el.findCount.textContent = '결과 없음';
    el.findCount.classList.add('none');
    return;
  }
  const idx = f.current ? f.matches.findIndex((m) => m.start === f.current.start) : -1;
  el.findCount.textContent = idx >= 0 ? `${idx + 1} / ${f.total}` : `${f.total}개`;
}

function renderHighlights() {
  if (state.mode === 'edit') renderBackdrop();
  else renderReaderMarks();
}

function renderBackdrop() {
  const f = state.find;
  const bd = el.backdrop;
  if (state.mode !== 'edit' || !f.open || !f.matches.length) {
    if (bd.firstChild) bd.textContent = '';
    return;
  }
  // 스크롤바 폭만큼 오른쪽 여백을 맞춰 줄바꿈 위치를 textarea 와 똑같이
  const sbw = Math.max(0, el.text.offsetWidth - el.text.clientWidth);
  const iosPad = isIOS ? 3 : 0; // iOS 의 textarea 는 좌우 3px 안쪽 여백이 더 있다
  bd.style.paddingLeft = `calc(var(--pad-x) + ${iosPad}px)`;
  bd.style.paddingRight = `calc(var(--pad-x) + ${sbw + iosPad}px)`;
  const text = currentText();
  const parts = [];
  let cursor = 0;
  for (const m of f.matches) {
    parts.push(escapeHTML(text.slice(cursor, m.start)));
    const cur = f.current && f.current.start === m.start && f.current.end === m.end;
    parts.push(cur ? '<mark class="cur">' : '<mark>', escapeHTML(text.slice(m.start, m.end)), '</mark>');
    cursor = m.end;
  }
  parts.push(escapeHTML(text.slice(cursor)), '\n​');
  bd.innerHTML = parts.join('');
  syncBackdropScroll();
}

function syncBackdropScroll() {
  el.backdrop.scrollTop = el.text.scrollTop;
  el.backdrop.scrollLeft = el.text.scrollLeft;
}

function renderReaderMarks() {
  const f = state.find;
  const kids = el.reader.children;
  for (const i of state.markedLines) {
    if (kids[i]) kids[i].textContent = state.lines[i];
  }
  state.markedLines = new Set();
  if (state.mode !== 'read' || !f.open || !f.matches.length) return;
  const byLine = new Map();
  for (const m of f.matches) {
    const li = lineIndexOf(m.start);
    if (!byLine.has(li)) byLine.set(li, []);
    byLine.get(li).push(m);
  }
  for (const [li, ms] of byLine) {
    const line = state.lines[li];
    const base = state.lineStarts[li];
    const node = kids[li];
    if (!node) continue;
    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const m of ms) {
      const s = m.start - base;
      const e = Math.min(m.end - base, line.length);
      if (s > cursor) frag.appendChild(document.createTextNode(line.slice(cursor, s)));
      const mark = document.createElement('mark');
      if (f.current && f.current.start === m.start) mark.className = 'cur';
      mark.textContent = line.slice(s, e);
      frag.appendChild(mark);
      cursor = e;
    }
    if (cursor < line.length) frag.appendChild(document.createTextNode(line.slice(cursor)));
    node.textContent = '';
    node.appendChild(frag);
    state.markedLines.add(li);
  }
}

function scrollToCurrentMatch() {
  if (state.mode === 'edit') {
    const mark = el.backdrop.querySelector('mark.cur');
    if (!mark) return;
    const y = mark.offsetTop;
    const top = el.text.scrollTop;
    const h = el.text.clientHeight;
    if (y < top + 10 || y > top + h - 50) el.text.scrollTop = Math.max(0, y - h * 0.35);
    syncBackdropScroll();
  } else {
    const mark = el.reader.querySelector('mark.cur');
    if (!mark) return;
    const y = mark.offsetTop;
    const top = el.reader.scrollTop;
    const h = el.reader.clientHeight;
    if (y < top + 10 || y > top + h - 50) el.reader.scrollTop = Math.max(0, y - h * 0.35);
  }
}

function selectMatch(m) {
  state.find.current = { start: m.start, end: m.end };
  if (state.mode === 'edit') el.text.setSelectionRange(m.start, m.end);
  renderHighlights();
  scrollToCurrentMatch();
  updateCount();
  updateStatus();
}

/** 지금 위치(찾기 기준점) */
function searchOrigin() {
  if (state.find.current) return state.find.current;
  if (state.mode === 'edit') return selectionNow();
  if (state.paragraph !== null) {
    const s = state.lineStarts[state.paragraph];
    return { start: s, end: s };
  }
  const i = firstVisibleLineIndexInReader();
  const s = state.lineStarts[i] || 0;
  return { start: s, end: s };
}

function performFind(direction) {
  const q = findQuery();
  if (!state.find.open) {
    openFind();
    if (!findQuery()) return;
  }
  if (!q) {
    el.findInput.focus();
    return;
  }
  if (!state.find.matches.length) refreshMatches();
  const from = searchOrigin();
  const found = S.find(currentText(), q, from, direction, state.find.options);
  if (!found) {
    toast(`"${q}"을(를) 찾을 수 없습니다`);
    return;
  }
  const wrapped = direction === 'forward' ? found.start < from.end : found.start > from.start;
  selectMatch(found);
  if (wrapped && state.find.total > 1) {
    toast(direction === 'forward' ? '끝까지 찾아서 처음부터 다시 찾았습니다' : '처음까지 찾아서 끝에서부터 다시 찾았습니다');
  }
}

function performReplace(direction) {
  if (state.mode !== 'edit') return;
  const q = findQuery();
  if (!q) return;
  const rep = el.replaceInput.value;
  const text = currentText();
  const sel = state.find.current || selectionNow();
  const target = S.replaceTarget(text, q, sel, direction, state.find.options);
  if (!target) {
    toast(`바꿀 "${q}"을(를) 찾을 수 없습니다`);
    return;
  }
  applyEdit(target.start, target.end, rep);
  refreshMatchesSoon.cancel();
  refreshMatches();
  const after = currentText();
  const origin =
    direction === 'forward'
      ? { start: target.start + rep.length, end: target.start + rep.length }
      : { start: target.start, end: target.start };
  const next = S.find(after, q, origin, direction, state.find.options);
  if (next) {
    selectMatch(next);
  } else {
    state.find.current = null;
    el.text.setSelectionRange(target.start + rep.length, target.start + rep.length);
    updateCount();
    renderHighlights();
    toast('마지막 항목까지 바꿨습니다');
  }
}

function performReplaceAll() {
  if (state.mode !== 'edit') return;
  const q = findQuery();
  if (!q) return;
  const text = currentText();
  const r = S.replaceAll(text, q, el.replaceInput.value, state.find.options);
  if (!r.count) {
    toast(`바꿀 "${q}"을(를) 찾을 수 없습니다`);
    return;
  }
  const caret = el.text.selectionStart;
  applyEdit(0, text.length, r.text);
  const c = Math.min(caret, r.text.length);
  el.text.setSelectionRange(c, c);
  refreshMatchesSoon.cancel();
  refreshMatches();
  toast(`${r.count}개를 바꿨습니다`);
}

function showAllResults() {
  const q = findQuery();
  if (!q) return;
  refreshMatches();
  const f = state.find;
  if (!f.total) {
    toast(`"${q}"을(를) 찾을 수 없습니다`);
    return;
  }
  const hits = S.hits(currentText(), f.matches.slice(0, 2000));
  const list = document.createElement('ul');
  let closeFn = null;
  for (const h of hits) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    const line = document.createElement('span');
    line.className = 'line';
    line.textContent = `${h.line}번째 줄`;
    const snip = document.createElement('span');
    snip.className = 'snip';
    if (h.matchStart >= 0) {
      snip.append(h.snippet.slice(0, h.matchStart));
      const bold = document.createElement('b');
      bold.textContent = h.snippet.slice(h.matchStart, h.matchEnd);
      snip.append(bold, h.snippet.slice(h.matchEnd));
    } else {
      snip.textContent = h.snippet || ' ';
    }
    b.append(line, snip);
    b.addEventListener('click', () => {
      if (closeFn) closeFn();
      selectMatch({ start: h.start, end: h.end });
    });
    li.appendChild(b);
    list.appendChild(li);
  }
  const extra = document.createElement('div');
  extra.appendChild(list);
  const p = dialog({
    title: hits.length < f.total ? `${f.total}개 찾음 · 처음 ${hits.length}개 표시` : `${f.total}개 찾음`,
    input: null,
    buttons: [{ label: '닫기', value: null }],
    cancelValue: null,
    className: 'results',
  });
  // 목록을 제목 아래에 끼워 넣는다
  const box = document.querySelector('.overlay:last-child .dialog');
  if (box) {
    box.insertBefore(extra, box.querySelector('.buttons'));
    closeFn = () => {
      const btn = box.querySelector('.buttons .btn');
      if (btn) btn.click();
    };
  }
  return p;
}

// ── 상태줄 ──────────────────────────────────────────────────────────────

function refreshTitle() {
  if (!state.doc) return;
  el.docName.textContent = state.doc.name;
  const parts = [state.mode === 'edit' ? '편집 중' : '읽기 모드'];
  if (state.dirty) parts.push('수정됨');
  if (state.doc.isNew) parts.push('아직 저장 안 함');
  el.docSub.textContent = parts.join(' · ');
  el.docSub.classList.toggle('dirty', state.dirty);
  document.title = `${state.dirty ? '• ' : ''}${state.doc.name} - 메모장`;
}

function updateStatus() {
  if (state.view !== 'editor') return;
  if (state.mode === 'edit') {
    const { line, column } = S.lineAndColumn(currentText(), el.text.selectionStart);
    el.stPos.textContent = `줄 ${line}, 열 ${column}`;
  } else if (state.paragraph !== null) {
    el.stPos.textContent = `줄 ${state.paragraph + 1} 선택`;
  } else {
    el.stPos.textContent = '읽기 모드';
  }
}
const updateStatusSoon = debounce(updateStatus, 80);

function updateCounts() {
  const text = currentText();
  const fmt = new Intl.NumberFormat('ko-KR');
  el.stCount.textContent = `${fmt.format(S.charCount(text))}자 · ${fmt.format(S.lineCount(text))}줄`;
}
const updateCountsSoon = debounce(updateCounts, 350);

function renderStatusMenus() {
  const doc = state.doc;
  if (!doc) return;
  const editing = state.mode === 'edit';
  el.stEol.textContent = '';
  for (const le of codec.LINE_ENDINGS) {
    const o = new Option(le.title, le.id, false, le.id === doc.lineEnding);
    el.stEol.appendChild(o);
  }
  el.stEol.value = doc.lineEnding;
  el.stEol.disabled = !editing;
  el.stEol.title = editing ? '저장할 줄 구분' : '줄 구분 (편집 모드에서 변경)';

  el.stEnc.textContent = '';
  const g1 = document.createElement('optgroup');
  g1.label = editing ? '저장할 문자셋' : '저장할 문자셋 (편집 모드에서 변경)';
  for (const enc of codec.ENCODINGS) {
    const o = new Option(enc.title, `enc:${enc.id}`, false, enc.id === doc.encoding);
    o.disabled = !editing && enc.id !== doc.encoding;
    g1.appendChild(o);
  }
  el.stEnc.appendChild(g1);
  if (doc.originalBytes) {
    const g2 = document.createElement('optgroup');
    g2.label = '이 문자셋으로 다시 읽기';
    for (const enc of codec.ENCODINGS) {
      g2.appendChild(new Option(`↻ ${enc.title}`, `reload:${enc.id}`));
    }
    el.stEnc.appendChild(g2);
  }
  el.stEnc.value = `enc:${doc.encoding}`;
  el.zoomReset.textContent = `${Math.round(state.zoom * 100)}%`;
}

async function onEncodingSelect() {
  const v = el.stEnc.value;
  const doc = state.doc;
  if (!doc) return;
  el.stEnc.value = `enc:${doc.encoding}`;
  const [kind, id] = v.split(':');
  if (kind === 'reload') {
    await reopenWith(id);
    return;
  }
  if (id === doc.encoding || state.mode !== 'edit') return;
  if (!codec.canEncode(currentText(), id)) {
    alertDialog(`${codec.encodingInfo(id).title}(으)로 저장할 수 없습니다`, '이 문서에는 그 문자셋에 없는 글자(이모지·일부 외국 문자 등)가 들어 있습니다. UTF-8 을 사용하세요.');
    return;
  }
  doc.encoding = id;
  state.dirty = true;
  refreshTitle();
  renderStatusMenus();
  saveSessionSoon();
  toast(`저장할 때 ${codec.encodingInfo(id).title}(으)로 저장합니다`);
}

function onLineEndingSelect() {
  const doc = state.doc;
  if (!doc || state.mode !== 'edit') return;
  const id = el.stEol.value;
  if (id === doc.lineEnding) return;
  doc.lineEnding = id;
  state.dirty = true;
  refreshTitle();
  saveSessionSoon();
  toast(`저장할 때 줄 구분을 ${codec.lineEndingInfo(id).title}(으)로 저장합니다`);
}

async function reopenWith(id) {
  const doc = state.doc;
  if (!doc || !doc.originalBytes) return;
  if (state.dirty) {
    const ok = await dialog({
      title: '다시 읽을까요?',
      message: `수정한 내용이 사라지고 파일을 ${codec.encodingInfo(id).title}(으)로 다시 읽습니다.`,
      buttons: [
        { label: '취소', value: false },
        { label: '다시 읽기', value: true, kind: 'danger' },
      ],
      cancelValue: false,
    });
    if (!ok) return;
  }
  const res = codec.decodeAs(doc.originalBytes, id);
  if (!res) {
    alertDialog('다시 읽을 수 없습니다', `이 파일은 ${codec.encodingInfo(id).title} 문자셋으로 읽을 수 없습니다.`);
    return;
  }
  doc.encoding = id;
  doc.lineEnding = res.lineEnding;
  doc.lossy = false;
  loadIntoEditor(res.text, state.mode);
  saveSessionSoon();
  toast(`${codec.encodingInfo(id).title}(으)로 다시 읽었습니다`);
}

function setZoom(z) {
  const zoom = Math.min(3, Math.max(0.5, Math.round(z * 10) / 10));
  state.zoom = zoom;
  document.documentElement.style.setProperty('--zoom', String(zoom));
  store.saveSetting('zoom', zoom);
  el.zoomReset.textContent = `${Math.round(zoom * 100)}%`;
  renderHighlights();
  if (state.paragraph !== null) positionParaBar();
}

function refreshAll() {
  refreshTitle();
  renderStatusMenus();
  updateUndoButtons();
  updateStatus();
  updateCounts();
}

// ── 세션 자동 보관(앱이 꺼져도 이어서) ─────────────────────────────────────

function sessionSnapshot() {
  if (!state.doc) return null;
  return {
    doc: {
      id: state.doc.id,
      name: state.doc.name,
      isNew: state.doc.isNew,
      encoding: state.doc.encoding,
      lineEnding: state.doc.lineEnding,
      lossy: state.doc.lossy,
    },
    originalBytes: state.doc.originalBytes ? state.doc.originalBytes.slice().buffer : null,
    text: currentText(),
    dirty: state.dirty,
    mode: state.mode,
    selection: selectionNow(),
    scrollTop: state.mode === 'edit' ? el.text.scrollTop : el.reader.scrollTop,
    savedAt: Date.now(),
  };
}

const saveSessionSoon = debounce(() => {
  const snap = sessionSnapshot();
  if (snap) store.saveSession(snap);
}, 800);

async function restoreSession() {
  const s = await store.loadSession();
  if (!s || !s.doc) return false;
  state.doc = {
    ...s.doc,
    originalBytes: s.originalBytes ? new Uint8Array(s.originalBytes) : null,
  };
  loadIntoEditor(s.text || '', s.mode === 'edit' ? 'edit' : 'read', {
    dirty: !!s.dirty,
    selection: s.selection,
    scrollTop: s.scrollTop || 0,
  });
  return true;
}

// ── 키보드 단축키 ───────────────────────────────────────────────────────

function onKeyDown(e) {
  if (dialogOpen > 0) return;
  if (e.isComposing || e.keyCode === 229) return;
  const mod = e.metaKey || e.ctrlKey;
  const code = e.code; // 한글 자판이어도 물리 키 기준(e.key 는 'ㄴ' 등이 될 수 있음)
  const inField = e.target === el.findInput || e.target === el.replaceInput;
  const editor = state.view === 'editor';

  if (e.key === 'Escape' && editor) {
    if (state.find.open) {
      e.preventDefault();
      closeFind();
    } else if (state.paragraph !== null) {
      closeParagraph();
    }
    return;
  }
  if (!mod) return;
  const shift = e.shiftKey;
  const alt = e.altKey;

  const run = (fn) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  };

  if (code === 'KeyN' && !shift) return run(requestNew);
  if (code === 'KeyO' && !shift) return run(requestOpen);
  if (!editor) return;

  if (code === 'KeyS') return run(() => saveDocument({ asNew: shift }));
  if (code === 'KeyF' && alt) return run(() => openReplace());
  if (code === 'KeyF') return run(() => openFind());
  if (code === 'KeyH' && e.ctrlKey) return run(() => openReplace());
  if (code === 'KeyG') return run(() => performFind(shift ? 'backward' : 'forward'));
  if (code === 'KeyE') return run(toggleMode);
  if (code === 'KeyW') return run(requestExit);
  if (code === 'Equal' || code === 'NumpadAdd') return run(() => setZoom(state.zoom + 0.1));
  if (code === 'Minus' || code === 'NumpadSubtract') return run(() => setZoom(state.zoom - 0.1));
  if (code === 'Digit0' || code === 'Numpad0') return run(() => setZoom(1));

  if (inField) return; // 찾기 칸 안의 실행 취소·전체 선택은 칸 자체 기능 그대로
  if (code === 'KeyZ' && !shift) return run(undo);
  if ((code === 'KeyZ' && shift) || code === 'KeyY') return run(redo);
  if (code === 'KeyA' && e.ctrlKey && !e.metaKey) {
    return run(() => {
      if (state.mode === 'edit') {
        el.text.focus({ preventScroll: true });
        el.text.select();
      } else {
        const r = document.createRange();
        r.selectNodeContents(el.reader);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
      }
    });
  }
}

function openReplace() {
  if (state.mode !== 'edit') {
    toast('바꾸기는 편집 모드에서 사용할 수 있습니다');
    openFind();
    return;
  }
  openFind({ replace: true });
}

// ── 화면 크기·키보드 ────────────────────────────────────────────────────

function updateViewport() {
  const vv = window.visualViewport;
  const root = document.documentElement;
  if (vv) {
    root.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
    root.style.setProperty('--vv-top', `${Math.round(vv.offsetTop)}px`);
  } else {
    root.style.setProperty('--app-h', `${window.innerHeight}px`);
  }
  if (state.paragraph !== null) repositionParaSoon();
}

// ── 이벤트 연결 ─────────────────────────────────────────────────────────

function wire() {
  el.homeNew.addEventListener('click', requestNew);
  el.homeOpen.addEventListener('click', requestOpen);
  el.fileInput.addEventListener('change', () => {
    const f = el.fileInput.files && el.fileInput.files[0];
    el.fileInput.value = '';
    handleFile(f);
  });

  el.btnExit.addEventListener('click', requestExit);
  el.btnFindTop.addEventListener('click', () => (state.find.open ? closeFind() : openFind()));
  el.btnMode.addEventListener('click', toggleMode);
  el.tbNew.addEventListener('click', requestNew);
  el.tbOpen.addEventListener('click', requestOpen);
  el.tbSave.addEventListener('click', () => saveDocument({ asNew: false }));
  el.tbSaveAs.addEventListener('click', () => saveDocument({ asNew: true }));
  el.tbUndo.addEventListener('click', undo);
  el.tbRedo.addEventListener('click', redo);
  el.tbFind.addEventListener('click', () => openFind());
  el.tbReplace.addEventListener('click', () => openReplace());
  // 툴바 버튼을 눌러도 본문 커서·키보드가 사라지지 않게
  for (const b of el.toolbar.querySelectorAll('button')) b.addEventListener('mousedown', (e) => e.preventDefault());

  el.findInput.addEventListener('input', () => {
    state.find.current = null;
    updateFindButtons();
    refreshMatchesSoon();
  });
  el.findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      performFind(e.shiftKey ? 'backward' : 'forward');
    }
  });
  el.replaceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      performReplace(e.shiftKey ? 'backward' : 'forward');
    }
  });
  el.findPrev.addEventListener('click', () => performFind('backward'));
  el.findNext.addEventListener('click', () => performFind('forward'));
  el.findAll.addEventListener('click', showAllResults);
  el.optCase.addEventListener('click', () => {
    const o = state.find.options;
    o.caseSensitive = !o.caseSensitive;
    el.optCase.classList.toggle('on', o.caseSensitive);
    el.optCase.setAttribute('aria-pressed', String(o.caseSensitive));
    state.find.current = null;
    refreshMatches();
  });
  el.optWrap.addEventListener('click', () => {
    const o = state.find.options;
    o.wrapAround = !o.wrapAround;
    el.optWrap.classList.toggle('on', o.wrapAround);
    el.optWrap.setAttribute('aria-pressed', String(o.wrapAround));
  });
  el.replaceToggle.addEventListener('change', () => {
    const on = el.replaceToggle.checked && state.mode === 'edit';
    el.replaceRow.hidden = !on;
    if (on) el.replaceInput.focus();
  });
  el.findClose.addEventListener('click', () => closeFind());
  el.repUp.addEventListener('click', () => performReplace('backward'));
  el.repDown.addEventListener('click', () => performReplace('forward'));
  el.repAll.addEventListener('click', performReplaceAll);

  // 본문 입력 → 실행 취소 기록
  el.text.addEventListener('beforeinput', (e) => {
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
      // 브라우저 자체 실행 취소는 쓰지 않고 앱의 기록으로 처리.
      // 찾기 칸에서 ⌘Z 를 눌렀는데 본문이 되돌려지는 일은 막는다.
      e.preventDefault();
      if (document.activeElement !== el.text) return;
      if (e.inputType === 'historyUndo') undo();
      else redo();
      return;
    }
    if (!composing && !pendingSel) pendingSel = selectionNow();
  });
  el.text.addEventListener('compositionstart', () => {
    composing = true;
    if (!pendingSel) pendingSel = selectionNow();
  });
  el.text.addEventListener('compositionend', () => {
    composing = false;
    // 일부 브라우저는 compositionend 뒤에 input 이 한 번 더 온다 — 같은 값이면 commitInput 이 무시
    setTimeout(() => commitInput(true), 0);
  });
  el.text.addEventListener('input', (e) => {
    if (composing || e.isComposing) {
      // 조합 중에도 화면 강조·상태는 가볍게만
      updateStatusSoon();
      return;
    }
    const t = e.inputType || '';
    commitInput(t === 'insertText' || t === 'insertCompositionText');
  });
  el.text.addEventListener('scroll', syncBackdropScroll, { passive: true });
  document.addEventListener('selectionchange', () => {
    if (document.activeElement === el.text) updateStatusSoon();
  });

  // 읽기 모드
  el.reader.addEventListener('click', onReaderClick);
  el.reader.addEventListener(
    'scroll',
    () => {
      if (state.paragraph !== null) {
        el.paraBar.hidden = true;
        repositionParaSoon();
      }
    },
    { passive: true },
  );
  el.paraCopy.addEventListener('click', copyParagraph);
  el.paraClose.addEventListener('click', closeParagraph);

  // 상태줄
  el.stEnc.addEventListener('change', onEncodingSelect);
  el.stEol.addEventListener('change', onLineEndingSelect);
  el.zoomIn.addEventListener('click', () => setZoom(state.zoom + 0.1));
  el.zoomOut.addEventListener('click', () => setZoom(state.zoom - 0.1));
  el.zoomReset.addEventListener('click', () => setZoom(1));

  document.addEventListener('keydown', onKeyDown, true);

  // 파일 끌어다 놓기(Split View 의 파일 앱에서 끌어오기)
  let dragDepth = 0;
  let zone = null;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    dragDepth++;
    if (!zone) {
      zone = document.createElement('div');
      zone.className = 'dropzone';
      zone.textContent = '여기에 놓으면 파일을 엽니다';
      document.body.appendChild(zone);
    }
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth && zone) {
      zone.remove();
      zone = null;
    }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    if (zone) {
      zone.remove();
      zone = null;
    }
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (state.view === 'editor' && needsSavePrompt()) {
      const name = state.doc.name;
      const choice = await dialog({
        title: state.doc.isNew ? `"${name}"을 저장할까요?` : `변경한 내용을 "${name}"에 저장할까요?`,
        buttons: [
          { label: '취소', value: 'cancel' },
          { label: '아니오', value: 'no', kind: 'danger' },
          { label: '예', value: 'yes', kind: 'primary' },
        ],
        cancelValue: 'cancel',
      });
      if (choice === 'cancel') return;
      if (choice === 'yes' && !(await saveDocument({ asNew: false }))) return;
    }
    handleFile(f);
  });

  // 화면 크기(키보드 포함)
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateViewport);
    window.visualViewport.addEventListener('scroll', updateViewport);
  }
  window.addEventListener('resize', () => {
    updateViewport();
    renderHighlights();
  });

  // 앱이 뒤로 가거나 닫히기 직전 바로 보관
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveSessionSoon.now();
  });
  window.addEventListener('pagehide', () => saveSessionSoon.now());
}

// ── 시작 ────────────────────────────────────────────────────────────────

async function start() {
  document.documentElement.style.setProperty('--zoom', String(state.zoom));
  updateViewport();
  wire();
  updateFindButtons();
  el.installTip.hidden = !(isIOS && !isStandalone);
  const restored = await restoreSession();
  if (!restored) showHome();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

// 테스트용 접근점
window.__memo = { state, codec, S };

start();
