// 앱 안 보관함(IndexedDB).
// - session: 지금 열려 있는 문서(앱이 꺼져도 다시 켜면 그대로 이어서).
// - library: 최근에 열거나 저장한 문서의 사본(웹앱은 파일 원본을 다시 열 수 없어서 사본을 보관).
// IndexedDB 를 못 쓰는 환경(일부 개인정보 보호 모드)에서는 메모리에만 두고 조용히 넘어간다.

const DB_NAME = 'memo-webapp';
const DB_VERSION = 2;
const LIBRARY_LIMIT = 30;

let dbPromise = null;
const memory = { session: null, library: new Map() };

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('library')) db.createObjectStore('library', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('libraryMeta')) {
          const meta = db.createObjectStore('libraryMeta', { keyPath: 'id' });
          // 기존(이전 버전) 문서도 보관. 한 번만 마이그레이션하며 본문은 건드리지 않는다.
          const cursor = req.transaction.objectStore('library').openCursor();
          cursor.onsuccess = () => {
            const c = cursor.result;
            if (!c) return;
            const { id, name, encoding, lineEnding, size, updatedAt } = c.value;
            meta.put({ id, name, encoding, lineEnding, size, updatedAt });
            c.continue();
          };
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function run(storeName, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) return resolve(undefined);
        try {
          const tx = db.transaction(storeName, mode);
          const store = tx.objectStore(storeName);
          const req = fn(store);
          tx.oncomplete = () => resolve(req ? req.result : undefined);
          tx.onerror = () => resolve(undefined);
          tx.onabort = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      }),
  );
}

export async function saveSession(session) {
  memory.session = session;
  await run('kv', 'readwrite', (s) => s.put(session, 'session'));
}

export async function loadSession() {
  const v = await run('kv', 'readonly', (s) => s.get('session'));
  return v === undefined ? memory.session : v;
}

export async function clearSession() {
  memory.session = null;
  await run('kv', 'readwrite', (s) => s.delete('session'));
}

export async function putLibrary(doc) {
  const stored = await run('library', 'readwrite', (s) => s.put(doc));
  if (stored === undefined) memory.library.set(doc.id, doc); // IndexedDB를 사용할 수 없을 때만 RAM에 사본 유지
  else memory.library.delete(doc.id);
  const { id, name, encoding, lineEnding, size, updatedAt } = doc;
  await run('libraryMeta', 'readwrite', (s) => s.put({ id, name, encoding, lineEnding, size, updatedAt }));
  // 오래된 것부터 정리
  const all = await listLibrary();
  if (all.length > LIBRARY_LIMIT) {
    for (const old of all.slice(LIBRARY_LIMIT)) await deleteLibrary(old.id);
  }
}

export async function listLibrary() {
  const v = await run('libraryMeta', 'readonly', (s) => s.getAll());
  const list = Array.isArray(v) ? v : Array.from(memory.library.values());
  return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getLibrary(id) {
  const v = await run('library', 'readonly', (s) => s.get(id));
  return v === undefined ? memory.library.get(id) : v;
}

export async function deleteLibrary(id) {
  memory.library.delete(id);
  await run('library', 'readwrite', (s) => s.delete(id));
  await run('libraryMeta', 'readwrite', (s) => s.delete(id));
}

export function loadSetting(key, fallback) {
  try {
    const v = localStorage.getItem(`memo.${key}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function saveSetting(key, value) {
  try {
    localStorage.setItem(`memo.${key}`, JSON.stringify(value));
  } catch {
    /* 저장 못 해도 동작에는 지장 없음 */
  }
}
