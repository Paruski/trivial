const DB_NAME = 'trivial-pages-static';
const DB_VERSION = 1;
const STORE = 'state';
const RUNTIME_KEY = 'runtime';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function emptyRuntime() {
  return { schemaVersion: 1, matches: [], events: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

export async function loadRuntime() {
  const database = await openDb();
  const row = await requestResult(database.transaction(STORE, 'readonly').objectStore(STORE).get(RUNTIME_KEY));
  return row?.value ?? emptyRuntime();
}

export async function saveRuntime(runtime) {
  runtime.updatedAt = new Date().toISOString();
  const database = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).put({ key: RUNTIME_KEY, value: runtime });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('No se pudo guardar la partida.'));
  });
}

export async function replaceRuntime(payload) {
  if (!payload || payload.schemaVersion !== 1 || !Array.isArray(payload.matches) || !Array.isArray(payload.events)) throw new Error('Copia local incompatible.');
  const runtime = { ...payload, updatedAt: new Date().toISOString() };
  await saveRuntime(runtime);
  return runtime;
}

export function downloadRuntime(runtime) {
  const blob = new Blob([JSON.stringify(runtime, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `trivial-local-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
