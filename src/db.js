import { SCHEMA_VERSION } from './domain.js';

const DB_NAME = 'trivial-pages';
const DB_VERSION = 4;
const DATA_STORES = ['banks','categories','levels','questions','players','matches','participants','attempts','exposures','events'];

function requestPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function ensureIndex(store, name, keyPath, options = {}) {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const database = req.result;
      const tx = req.transaction;
      const getStore = (name, keyPath) => database.objectStoreNames.contains(name)
        ? tx.objectStore(name)
        : database.createObjectStore(name, { keyPath });

      getStore('banks', 'bankId');
      getStore('categories', 'categoryId');
      getStore('levels', 'levelKey');
      const questions = getStore('questions', 'questionKey');
      ensureIndex(questions, 'bankId', 'bankId');
      ensureIndex(questions, 'status', 'status');
      getStore('players', 'playerId');
      getStore('matches', 'matchId');
      const participants = getStore('participants', 'matchPlayerId');
      ensureIndex(participants, 'matchId', 'matchId');
      ensureIndex(participants, 'playerId', 'playerId');
      const attempts = getStore('attempts', 'attemptId');
      ensureIndex(attempts, 'matchId', 'matchId');
      ensureIndex(attempts, 'playerId', 'playerId');
      ensureIndex(attempts, 'questionKey', 'questionKey');
      ensureIndex(attempts, 'sourceEventId', 'sourceEventId');
      const exposures = getStore('exposures', 'exposureId');
      ensureIndex(exposures, 'matchId', 'matchId');
      ensureIndex(exposures, 'questionKey', 'questionKey');
      ensureIndex(exposures, 'sourceEventId', 'sourceEventId');
      const events = getStore('events', 'eventId');
      ensureIndex(events, 'matchId', 'matchId');
      getStore('meta', 'key');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txPromise(storeNames, mode, fn) {
  return openDb().then((database) => new Promise((resolve, reject) => {
    const tx = database.transaction(storeNames, mode);
    const stores = Object.fromEntries(storeNames.map((name) => [name, tx.objectStore(name)]));
    let value;
    try { value = fn(stores, tx); } catch (error) { reject(error); return; }
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transacción abortada'));
  }));
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`No se pudo cargar ${path} (${response.status})`);
  return response.json();
}

async function loadSeed() {
  const meta = await fetchJson('./data/meta.json');
  const [qAL,qLI,qFI,qHI,qIN,qNE,aJ1,aJ2,aJ3] = await Promise.all([
    fetchJson('./data/questions-AL.json'), fetchJson('./data/questions-LI.json'),
    fetchJson('./data/questions-FI.json'), fetchJson('./data/questions-HI.json'),
    fetchJson('./data/questions-IN.json'), fetchJson('./data/questions-NE.json'),
    fetchJson('./data/attempts-J1.json'), fetchJson('./data/attempts-J2.json'), fetchJson('./data/attempts-J3.json'),
  ]);
  return { ...meta, questions: [...qAL,...qLI,...qFI,...qHI,...qIN,...qNE], attempts: [...aJ1,...aJ2,...aJ3] };
}

export const db = {
  async init() {
    await openDb();
    const seed = await loadSeed();
    await this.ensureSeed(seed);
    await this.setMeta('schemaVersion', SCHEMA_VERSION);
    return seed;
  },

  async getAll(store) {
    const database = await openDb();
    return requestPromise(database.transaction(store, 'readonly').objectStore(store).getAll());
  },

  async get(store, key) {
    const database = await openDb();
    return requestPromise(database.transaction(store, 'readonly').objectStore(store).get(key));
  },

  async getByIndex(store, indexName, value) {
    const database = await openDb();
    return requestPromise(database.transaction(store, 'readonly').objectStore(store).index(indexName).getAll(value));
  },

  async put(store, value) {
    return txPromise([store], 'readwrite', (s) => s[store].put(value));
  },

  async putMany(store, values) {
    if (!values?.length) return;
    return txPromise([store], 'readwrite', (s) => values.forEach((value) => s[store].put(value)));
  },

  async atomicPut(putsByStore) {
    const storeNames = Object.keys(putsByStore).filter((name) => putsByStore[name]?.length);
    if (!storeNames.length) return;
    return txPromise(storeNames, 'readwrite', (stores) => {
      for (const name of storeNames) for (const value of putsByStore[name]) stores[name].put(value);
    });
  },

  async clear(store) {
    return txPromise([store], 'readwrite', (s) => s[store].clear());
  },

  async eventsForMatch(matchId) { return this.getByIndex('events', 'matchId', matchId); },
  async attemptsForMatch(matchId) { return this.getByIndex('attempts', 'matchId', matchId); },
  async participantsForMatch(matchId) { return this.getByIndex('participants', 'matchId', matchId); },
  async questionsForBank(bankId) { return this.getByIndex('questions', 'bankId', bankId); },

  async getMeta(key) { return (await this.get('meta', key))?.value; },
  async setMeta(key, value) { return this.put('meta', { key, value }); },

  async putIfMissing(store, key, value) {
    if (await this.get(store, key)) return false;
    await this.put(store, value);
    return true;
  },

  async ensureSeed(seed) {
    if (!seed?.seedVersion || !seed?.bank) throw new Error('Base integrada no válida');
    const applied = await this.getMeta('seedVersion');
    if (applied === seed.seedVersion) return;

    await this.putIfMissing('banks', seed.bank.bankId, seed.bank);
    for (const row of seed.bank.categories ?? []) await this.putIfMissing('categories', row.categoryId, row);
    for (const row of seed.bank.levels ?? []) await this.putIfMissing('levels', row.levelKey, row);
    for (const row of seed.players ?? []) await this.putIfMissing('players', row.playerId, row);
    for (const row of seed.questions ?? []) await this.putIfMissing('questions', row.questionKey, row);
    for (const row of seed.matches ?? []) await this.putIfMissing('matches', row.matchId, row);
    for (const row of seed.participants ?? []) await this.putIfMissing('participants', row.matchPlayerId, row);
    for (const row of seed.attempts ?? []) await this.putIfMissing('attempts', row.attemptId, row);
    for (const row of seed.exposures ?? []) await this.putIfMissing('exposures', row.exposureId, row);
    await this.setMeta('seedVersion', seed.seedVersion);
  },

  async resetToSeed() {
    const seed = await loadSeed();
    for (const store of DATA_STORES) await this.clear(store);
    await this.clear('meta');
    await this.ensureSeed(seed);
    await this.setMeta('schemaVersion', SCHEMA_VERSION);
    return seed;
  },

  async exportAll() {
    const result = { schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString() };
    for (const store of [...DATA_STORES, 'meta']) result[store] = await this.getAll(store);
    return result;
  },

  async importAll(payload, { replace = false } = {}) {
    if (!payload || !Array.isArray(payload.matches) || !Array.isArray(payload.attempts)) throw new Error('Copia no válida');
    if (replace) for (const store of [...DATA_STORES, 'meta']) await this.clear(store);
    for (const store of DATA_STORES) if (Array.isArray(payload[store])) await this.putMany(store, payload[store]);
    if (Array.isArray(payload.meta)) await this.putMany('meta', payload.meta);
    await this.setMeta('schemaVersion', payload.schemaVersion ?? SCHEMA_VERSION);
  },
};
