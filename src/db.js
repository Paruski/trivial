import { DATA_STORES, EVENT_SCHEMA_VERSION, SCHEMA_VERSION } from './config.js';
import { makeEvent } from './domain.js';
import { loadSeed } from './seed.js';

const DB_NAME = 'trivial-pages';
const DB_VERSION = 7;
const META_STORE = 'meta';
const ALL_STORES = [...DATA_STORES, META_STORE];
const localQueues = new Map();
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('trivial-pages-sync-v1') : null;

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionPromise(transaction, value = undefined) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(value);
    transaction.onerror = () => reject(transaction.error ?? new Error('Error de transacción'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Transacción abortada'));
  });
}

function ensureIndex(store, name, keyPath, options = {}) {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options);
}

function createStores(database, transaction) {
  const ensureStore = (name, keyPath) => database.objectStoreNames.contains(name) ? transaction.objectStore(name) : database.createObjectStore(name, { keyPath });
  const banks = ensureStore('banks', 'bankId'); ensureIndex(banks, 'seedOwned', 'seedOwned');
  if (database.objectStoreNames.contains('categories') && transaction.objectStore('categories').keyPath !== 'categoryKey') database.deleteObjectStore('categories');
  const categories = ensureStore('categories', 'categoryKey'); ensureIndex(categories, 'bankId', 'bankId');
  ensureStore('levels', 'levelKey');
  const questions = ensureStore('questions', 'questionKey'); ensureIndex(questions, 'bankId', 'bankId'); ensureIndex(questions, 'status', 'status');
  ensureStore('players', 'playerId');
  const matches = ensureStore('matches', 'matchId'); ensureIndex(matches, 'bankId', 'bankId'); ensureIndex(matches, 'source', 'source');
  const participants = ensureStore('participants', 'matchPlayerId'); ensureIndex(participants, 'matchId', 'matchId'); ensureIndex(participants, 'playerId', 'playerId');
  const attempts = ensureStore('attempts', 'attemptId'); ensureIndex(attempts, 'matchId', 'matchId'); ensureIndex(attempts, 'playerId', 'playerId'); ensureIndex(attempts, 'questionKey', 'questionKey'); ensureIndex(attempts, 'sourceEventId', 'sourceEventId');
  const exposures = ensureStore('exposures', 'exposureId'); ensureIndex(exposures, 'matchId', 'matchId'); ensureIndex(exposures, 'questionKey', 'questionKey'); ensureIndex(exposures, 'sourceEventId', 'sourceEventId');
  const events = ensureStore('events', 'eventId'); ensureIndex(events, 'matchId', 'matchId'); ensureIndex(events, 'matchSeq', ['matchId', 'seq'], { unique: true }); ensureIndex(events, 'idempotencyKey', 'idempotencyKey', { unique: true });
  ensureStore(META_STORE, 'key');
  if (transaction.objectStoreNames.contains('events')) {
    const cursorRequest = transaction.objectStore('events').openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      const event = cursor.value;
      let changed = false;
      if (!event.timestamp && event.ts) { event.timestamp = event.ts; delete event.ts; changed = true; }
      if (!event.schemaVersion) { event.schemaVersion = EVENT_SCHEMA_VERSION; changed = true; }
      if (changed) cursor.update(event);
      cursor.continue();
    };
  }
}

export function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => createStores(request.result, request.transaction);
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Otra pestaña bloquea la migración. Ciérrala y recarga.'));
  });
}

async function localLock(name, task) {
  const previous = localQueues.get(name) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  localQueues.set(name, queued);
  await previous;
  try { return await task(); }
  finally { release(); if (localQueues.get(name) === queued) localQueues.delete(name); }
}

export async function withWriteLock(name, task) {
  if (globalThis.navigator?.locks?.request) return navigator.locks.request(`trivial:${name}`, { mode: 'exclusive' }, task);
  return localLock(name, task);
}

async function readAll(storeName) {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, 'readonly');
  return requestPromise(transaction.objectStore(storeName).getAll());
}

async function getByIndex(storeName, indexName, value) {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, 'readonly');
  return requestPromise(transaction.objectStore(storeName).index(indexName).getAll(value));
}

function clearAndPutSeed(transaction, seed) {
  for (const storeName of DATA_STORES) transaction.objectStore(storeName).clear();
  transaction.objectStore(META_STORE).clear();
  for (const storeName of DATA_STORES) for (const row of seed[storeName] ?? []) transaction.objectStore(storeName).put(row);
  const meta = transaction.objectStore(META_STORE);
  for (const row of seed.meta) meta.put(row);
  meta.put({ key: 'seedVersion', value: seed.seedVersion });
  meta.put({ key: 'schemaVersion', value: SCHEMA_VERSION });
  meta.put({ key: 'lastIntegrityCheck', value: new Date().toISOString() });
}

async function reconcileSeed(seed) {
  return withWriteLock('seed', async () => {
    const database = await openDatabase();
    const current = await requestPromise(database.transaction(META_STORE, 'readonly').objectStore(META_STORE).get('seedVersion'));
    if (current?.value === seed.seedVersion) return;
    const existing = Object.fromEntries(await Promise.all(DATA_STORES.map(async (storeName) => [storeName, await readAll(storeName)])));
    const transaction = database.transaction(ALL_STORES, 'readwrite');
    const bankIds = new Set(seed.banks.map((row) => row.bankId));
    const primaryKeys = { banks: 'bankId', categories: 'categoryKey', levels: 'levelKey', questions: 'questionKey', players: 'playerId', matches: 'matchId', participants: 'matchPlayerId', attempts: 'attemptId', exposures: 'exposureId', events: 'eventId' };
    const replaceSeedRows = (storeName, shouldDelete) => {
      const store = transaction.objectStore(storeName);
      for (const row of existing[storeName].filter(shouldDelete)) store.delete(row[primaryKeys[storeName]]);
      for (const row of seed[storeName] ?? []) store.put(row);
    };
    replaceSeedRows('banks', (row) => row.seedOwned === true || bankIds.has(row.bankId));
    replaceSeedRows('categories', (row) => row.seedOwned === true || bankIds.has(row.bankId));
    replaceSeedRows('levels', (row) => row.seedOwned === true);
    replaceSeedRows('questions', (row) => row.seedOwned === true || bankIds.has(row.bankId));
    replaceSeedRows('players', (row) => row.seedOwned === true);
    replaceSeedRows('matches', (row) => row.seedOwned === true || row.source === 'historical_seed');
    const historicalMatchIds = new Set(seed.matches.map((row) => row.matchId));
    replaceSeedRows('participants', (row) => row.seedOwned === true || historicalMatchIds.has(row.matchId));
    replaceSeedRows('attempts', (row) => row.seedOwned === true || row.source === 'historical_seed');
    replaceSeedRows('exposures', (row) => row.seedOwned === true || row.source === 'historical_seed');
    replaceSeedRows('events', (row) => row.seedOwned === true);
    const meta = transaction.objectStore(META_STORE);
    for (const row of seed.meta) meta.put(row);
    meta.put({ key: 'seedVersion', value: seed.seedVersion });
    meta.put({ key: 'schemaVersion', value: SCHEMA_VERSION });
    await transactionPromise(transaction);
    channel?.postMessage({ type: 'seed-updated', seedVersion: seed.seedVersion });
  });
}

function appendInTransaction(transaction, matchId, specifications) {
  const eventStore = transaction.objectStore('events');
  const index = eventStore.index('matchId');
  const request = index.getAll(matchId);
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      try {
        const existing = request.result;
        const specs = typeof specifications === 'function' ? specifications(existing) : specifications;
        if (!Array.isArray(specs) || !specs.length) { resolve([]); return; }
        const duplicate = specs.find((spec) => spec.idempotencyKey && existing.some((event) => event.idempotencyKey === spec.idempotencyKey));
        if (duplicate) { resolve(existing.filter((event) => event.idempotencyKey === duplicate.idempotencyKey)); return; }
        let seq = Math.max(0, ...existing.map((event) => Number(event.seq) || 0));
        const committed = specs.map((spec) => makeEvent({ matchId, seq: ++seq, ...spec }));
        for (const event of committed) eventStore.add(event);
        resolve(committed);
      } catch (error) { transaction.abort(); reject(error); }
    };
  });
}

export const db = {
  onChange(listener) {
    if (!channel) return () => {};
    const handler = (event) => listener(event.data);
    channel.addEventListener('message', handler);
    return () => channel.removeEventListener('message', handler);
  },
  async init() {
    await openDatabase();
    const seed = await loadSeed();
    await reconcileSeed(seed);
    return seed;
  },
  getAll: readAll,
  getByIndex,
  async get(storeName, key) {
    const database = await openDatabase();
    return requestPromise(database.transaction(storeName, 'readonly').objectStore(storeName).get(key));
  },
  eventsForMatch(matchId) { return getByIndex('events', 'matchId', matchId); },
  async snapshot() {
    const result = {};
    for (const storeName of ALL_STORES) result[storeName] = await readAll(storeName);
    return result;
  },
  async createMatch(match, participants, createdSpec) {
    return withWriteLock(`match:${match.matchId}`, async () => {
      const database = await openDatabase();
      const transaction = database.transaction(['matches', 'participants', 'events'], 'readwrite');
      transaction.objectStore('matches').add(match);
      for (const participant of participants) transaction.objectStore('participants').add(participant);
      const events = await appendInTransaction(transaction, match.matchId, [createdSpec]);
      await transactionPromise(transaction);
      channel?.postMessage({ type: 'match-created', matchId: match.matchId });
      return events;
    });
  },
  async commitMatch(matchId, specifications) {
    return withWriteLock(`match:${matchId}`, async () => {
      const database = await openDatabase();
      const transaction = database.transaction('events', 'readwrite');
      const events = await appendInTransaction(transaction, matchId, specifications);
      await transactionPromise(transaction);
      channel?.postMessage({ type: 'events-appended', matchId });
      return events;
    });
  },
  async resetToSeed() {
    const seed = await loadSeed();
    return withWriteLock('database', async () => {
      const database = await openDatabase();
      const transaction = database.transaction(ALL_STORES, 'readwrite');
      clearAndPutSeed(transaction, seed);
      await transactionPromise(transaction);
      channel?.postMessage({ type: 'database-reset' });
      return seed;
    });
  },
  async replaceAll(payload) {
    return withWriteLock('database', async () => {
      const database = await openDatabase();
      const transaction = database.transaction(ALL_STORES, 'readwrite');
      for (const storeName of ALL_STORES) transaction.objectStore(storeName).clear();
      for (const storeName of DATA_STORES) for (const row of payload[storeName]) transaction.objectStore(storeName).add(row);
      for (const row of payload.meta) transaction.objectStore(META_STORE).put(row);
      await transactionPromise(transaction);
      channel?.postMessage({ type: 'backup-restored' });
    });
  },
};
