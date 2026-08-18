import { SCHEMA_VERSION } from './domain.js';

const DB_NAME = 'trivial-pages';
const DB_VERSION = 2;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('banks')) db.createObjectStore('banks', { keyPath: 'bankId' });
      if (!db.objectStoreNames.contains('questions')) {
        const store = db.createObjectStore('questions', { keyPath: 'questionKey' });
        store.createIndex('bankId', 'bankId');
      }
      if (!db.objectStoreNames.contains('players')) db.createObjectStore('players', { keyPath: 'playerId' });
      if (!db.objectStoreNames.contains('matches')) db.createObjectStore('matches', { keyPath: 'matchId' });
      if (!db.objectStoreNames.contains('events')) {
        const store = db.createObjectStore('events', { keyPath: 'eventId' });
        store.createIndex('matchId', 'matchId');
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txPromise(storeNames, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    const stores = Object.fromEntries(storeNames.map((name) => [name, tx.objectStore(name)]));
    let result;
    try { result = fn(stores, tx); } catch (err) { reject(err); return; }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  }));
}

function requestPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const db = {
  async init() {
    await openDb();
    const meta = await this.getMeta('schemaVersion');
    if (!meta) await this.setMeta('schemaVersion', SCHEMA_VERSION);
  },

  async getAll(store) {
    const database = await openDb();
    return requestPromise(database.transaction(store, 'readonly').objectStore(store).getAll());
  },

  async get(store, key) {
    const database = await openDb();
    return requestPromise(database.transaction(store, 'readonly').objectStore(store).get(key));
  },

  async put(store, value) {
    return txPromise([store], 'readwrite', (s) => s[store].put(value));
  },

  async putMany(store, values) {
    return txPromise([store], 'readwrite', (s) => values.forEach((v) => s[store].put(v)));
  },

  async delete(store, key) {
    return txPromise([store], 'readwrite', (s) => s[store].delete(key));
  },

  async clear(store) {
    return txPromise([store], 'readwrite', (s) => s[store].clear());
  },

  async eventsForMatch(matchId) {
    const database = await openDb();
    const index = database.transaction('events', 'readonly').objectStore('events').index('matchId');
    return requestPromise(index.getAll(matchId));
  },

  async questionsForBank(bankId) {
    const database = await openDb();
    const index = database.transaction('questions', 'readonly').objectStore('questions').index('bankId');
    return requestPromise(index.getAll(bankId));
  },

  async getMeta(key) {
    return (await this.get('meta', key))?.value;
  },

  async setMeta(key, value) {
    return this.put('meta', { key, value });
  },

  async exportAll() {
    const [banks, questions, players, matches, events, meta] = await Promise.all([
      this.getAll('banks'), this.getAll('questions'), this.getAll('players'), this.getAll('matches'), this.getAll('events'), this.getAll('meta')
    ]);
    return { schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), banks, questions, players, matches, events, meta };
  },

  async importAll(payload, { replace = false } = {}) {
    if (!payload || !Array.isArray(payload.matches) || !Array.isArray(payload.events)) throw new Error('Copia no válida');
    if (replace) {
      for (const store of ['banks', 'questions', 'players', 'matches', 'events', 'meta']) await this.clear(store);
    }
    await this.putMany('banks', payload.banks ?? []);
    await this.putMany('questions', payload.questions ?? []);
    await this.putMany('players', payload.players ?? []);
    await this.putMany('matches', payload.matches ?? []);
    await this.putMany('events', payload.events ?? []);
    await this.setMeta('schemaVersion', payload.schemaVersion ?? SCHEMA_VERSION);
  }
};
