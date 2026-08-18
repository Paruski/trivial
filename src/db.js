import { SCHEMA_VERSION } from './domain.js';
import { fetchCsv, csvBool, csvNullableBool, csvInt, csvList } from './csv.js';

const DB_NAME = 'trivial-pages';
const DB_VERSION = 5;
const DATA_STORES = ['banks','categories','levels','questions','players','matches','participants','attempts','exposures','events'];
const CSV_FILES = Object.freeze({
  meta: './data/meta.csv', banks: './data/banks.csv', categories: './data/categories.csv', levels: './data/levels.csv',
  players: './data/players.csv', matches: './data/matches.csv', participants: './data/participants.csv',
  exposures: './data/exposures.csv', events: './data/events.csv',
});
const QUESTION_FILES = ['AL','LI','FI','HI','IN','NE'].map((id) => `./data/questions-${id}.csv`);
const ATTEMPT_FILES = ['J1','J2','J3'].map((id) => `./data/attempts-${id}.csv`);

function requestPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function ensureIndex(store, name, keyPath, options = {}) { if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options); }
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const database = req.result, tx = req.transaction;
      const getStore = (name, keyPath) => database.objectStoreNames.contains(name) ? tx.objectStore(name) : database.createObjectStore(name, { keyPath });
      getStore('banks', 'bankId'); getStore('categories', 'categoryId'); getStore('levels', 'levelKey');
      const questions = getStore('questions', 'questionKey'); ensureIndex(questions, 'bankId', 'bankId'); ensureIndex(questions, 'status', 'status');
      getStore('players', 'playerId'); getStore('matches', 'matchId');
      const participants = getStore('participants', 'matchPlayerId'); ensureIndex(participants, 'matchId', 'matchId'); ensureIndex(participants, 'playerId', 'playerId');
      const attempts = getStore('attempts', 'attemptId'); ensureIndex(attempts, 'matchId', 'matchId'); ensureIndex(attempts, 'playerId', 'playerId'); ensureIndex(attempts, 'questionKey', 'questionKey'); ensureIndex(attempts, 'sourceEventId', 'sourceEventId');
      const exposures = getStore('exposures', 'exposureId'); ensureIndex(exposures, 'matchId', 'matchId'); ensureIndex(exposures, 'questionKey', 'questionKey'); ensureIndex(exposures, 'sourceEventId', 'sourceEventId');
      const events = getStore('events', 'eventId'); ensureIndex(events, 'matchId', 'matchId'); getStore('meta', 'key');
    };
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
}
function txPromise(storeNames, mode, fn) {
  return openDb().then((database) => new Promise((resolve, reject) => {
    const tx = database.transaction(storeNames, mode), stores = Object.fromEntries(storeNames.map((name) => [name, tx.objectStore(name)]));
    let value; try { value = fn(stores, tx); } catch (error) { reject(error); return; }
    tx.oncomplete = () => resolve(value); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error('Transacción abortada'));
  }));
}
function mapSeed(raw) {
  const metaMap = Object.fromEntries(raw.meta.map((r) => [r.key, r.value]));
  const banks = raw.banks.map((r) => ({ bankId:r.bank_id, name:r.name, seedVersion:r.seed_version, questionCount:csvInt(r.question_count), levelWeightsPolicy:r.level_weights_policy }));
  const categories = raw.categories.map((r) => ({ categoryId:r.category_id, label:r.label, color:r.color, emoji:r.emoji, active:csvBool(r.active,true), quesitoDefault:csvBool(r.quesito_default,true) }));
  const levels = raw.levels.map((r) => ({ levelKey:r.level_key, scaleId:r.scale_id, levelIdLocal:r.level_id_local, label:r.label, order:csvInt(r.order), description:r.description }));
  for (const bank of banks) { bank.categories = categories; bank.levels = levels; }
  const questions = raw.questions.map((r) => ({ questionKey:r.question_key, bankId:r.bank_id, questionId:r.question_id, categoryId:r.category_id, levelKey:r.level_key, prompt:r.prompt, answer:r.answer, explanation:r.explanation, status:r.status, sourceStatus:r.source_status, randomOrder:csvInt(r.random_order, Number.MAX_SAFE_INTEGER) }));
  const players = raw.players.map((r) => ({ playerId:r.player_id, name:r.name, active:csvBool(r.active,true) }));
  const matches = raw.matches.map((r) => ({ matchId:r.match_id, name:r.name, bankId:r.bank_id, playerIds:csvList(r.player_ids), enabledCategoryIds:csvList(r.enabled_category_ids), enabledLevelKeys:csvList(r.enabled_level_keys), status:r.status, createdAt:r.created_at || null, closedAt:r.closed_at || null, closeReason:r.close_reason || null, seed:r.seed, source:r.source }));
  const participants = raw.participants.map((r) => ({ matchPlayerId:r.match_player_id, matchId:r.match_id, playerId:r.player_id, seatNo:csvInt(r.seat_no), active:csvBool(r.active,true) }));
  const attempts = raw.attempts.map((r) => ({ attemptId:r.attempt_id, matchId:r.match_id, questionNo:csvInt(r.question_no), playerId:r.player_id, questionId:r.question_id, questionKey:r.question_key, bankId:r.bank_id, categoryId:r.category_id, levelKey:r.level_key, resultId:r.result_id, computable:csvBool(r.computable,true), correct:csvNullableBool(r.correct), quesitoAttempt:csvBool(r.quesito_attempt), quesitoWon:csvBool(r.quesito_won), notes:r.notes, active:csvBool(r.active,true), source:r.source, sourceEventId:r.source_event_id || null }));
  const exposures = raw.exposures.map((r) => ({ exposureId:r.exposure_id, matchId:r.match_id || null, bankId:r.bank_id || null, questionKey:r.question_key || null, questionId:r.question_id || null, playerId:r.player_id || null, questionNoRel:r.question_no ? csvInt(r.question_no) : null, type:r.type, countsAsAttempt:csvBool(r.counts_as_attempt), reason:r.reason, source:r.source, active:csvBool(r.active,true), sourceEventId:r.source_event_id || null }));
  const events = raw.events.map((r) => ({ eventId:r.event_id, matchId:r.match_id, seq:csvInt(r.seq), type:r.type, ts:r.ts, payload:r.payload_json ? JSON.parse(r.payload_json) : {} }));
  const bank = banks.find((b) => b.bankId === metaMap.canonical_bank_id) ?? banks[0];
  if (!bank) throw new Error('No hay banco canónico en los CSV integrados');
  if (bank.questionCount !== questions.filter((q) => q.bankId === bank.bankId).length) throw new Error('Conteo de preguntas incoherente en los CSV integrados');
  return { seedVersion:metaMap.seed_version, bank, banks, categories, levels, questions, players, matches, participants, attempts, exposures, events, meta:raw.meta };
}
async function loadSeed() {
  const names = Object.keys(CSV_FILES);
  const [tables, questionParts, attemptParts] = await Promise.all([Promise.all(names.map((name) => fetchCsv(CSV_FILES[name]))), Promise.all(QUESTION_FILES.map(fetchCsv)), Promise.all(ATTEMPT_FILES.map(fetchCsv))]);
  const raw = Object.fromEntries(names.map((name, index) => [name, tables[index]])); raw.questions = questionParts.flat(); raw.attempts = attemptParts.flat(); return mapSeed(raw);
}
export const db = {
  async init() { await openDb(); const seed = await loadSeed(); await this.ensureSeed(seed); await this.setMeta('schemaVersion', SCHEMA_VERSION); return seed; },
  async getAll(store) { const database = await openDb(); return requestPromise(database.transaction(store, 'readonly').objectStore(store).getAll()); },
  async get(store, key) { const database = await openDb(); return requestPromise(database.transaction(store, 'readonly').objectStore(store).get(key)); },
  async getByIndex(store, indexName, value) { const database = await openDb(); return requestPromise(database.transaction(store, 'readonly').objectStore(store).index(indexName).getAll(value)); },
  async put(store, value) { return txPromise([store], 'readwrite', (s) => s[store].put(value)); },
  async putMany(store, values) { if (!values?.length) return; return txPromise([store], 'readwrite', (s) => values.forEach((value) => s[store].put(value))); },
  async atomicPut(putsByStore) { const storeNames = Object.keys(putsByStore).filter((name) => putsByStore[name]?.length); if (!storeNames.length) return; return txPromise(storeNames, 'readwrite', (stores) => { for (const name of storeNames) for (const value of putsByStore[name]) stores[name].put(value); }); },
  async clear(store) { return txPromise([store], 'readwrite', (s) => s[store].clear()); },
  async eventsForMatch(matchId) { return this.getByIndex('events', 'matchId', matchId); }, async attemptsForMatch(matchId) { return this.getByIndex('attempts', 'matchId', matchId); }, async participantsForMatch(matchId) { return this.getByIndex('participants', 'matchId', matchId); }, async questionsForBank(bankId) { return this.getByIndex('questions', 'bankId', bankId); },
  async getMeta(key) { return (await this.get('meta', key))?.value; }, async setMeta(key, value) { return this.put('meta', { key, value }); },
  async putIfMissing(store, key, value) { if (await this.get(store, key)) return false; await this.put(store, value); return true; },
  async reconcileCanonicalSeed(seed) {
    const bankIds = new Set(seed.banks.map((row) => row.bankId));
    const questionKeys = new Set(seed.questions.map((row) => row.questionKey));
    const historicalMatchIds = new Set(seed.matches.filter((row) => row.source === 'historical_seed').map((row) => row.matchId));
    const attemptIds = new Set(seed.attempts.filter((row) => historicalMatchIds.has(row.matchId)).map((row) => row.attemptId));
    const exposureIds = new Set(seed.exposures.filter((row) => historicalMatchIds.has(row.matchId)).map((row) => row.exposureId));
    await txPromise(['banks','questions','matches','participants','attempts','exposures'], 'readwrite', (stores) => {
      const qCursor = stores.questions.openCursor();
      qCursor.onsuccess = () => {
        const cursor = qCursor.result; if (!cursor) return;
        if (bankIds.has(cursor.value.bankId) && !questionKeys.has(cursor.value.questionKey)) cursor.delete();
        cursor.continue();
      };
      const aCursor = stores.attempts.openCursor();
      aCursor.onsuccess = () => {
        const cursor = aCursor.result; if (!cursor) return;
        if (historicalMatchIds.has(cursor.value.matchId) && !attemptIds.has(cursor.value.attemptId)) cursor.delete();
        cursor.continue();
      };
      const eCursor = stores.exposures.openCursor();
      eCursor.onsuccess = () => {
        const cursor = eCursor.result; if (!cursor) return;
        if (historicalMatchIds.has(cursor.value.matchId) && !cursor.value.sourceEventId && !exposureIds.has(cursor.value.exposureId)) cursor.delete();
        cursor.continue();
      };
      for (const row of seed.banks) stores.banks.put(row);
      for (const row of seed.matches.filter((r) => historicalMatchIds.has(r.matchId))) stores.matches.put(row);
      for (const row of seed.participants.filter((r) => historicalMatchIds.has(r.matchId))) stores.participants.put(row);
      for (const row of seed.attempts.filter((r) => historicalMatchIds.has(r.matchId))) stores.attempts.put(row);
      for (const row of seed.exposures.filter((r) => historicalMatchIds.has(r.matchId))) stores.exposures.put(row);
    });
  },
  async ensureSeed(seed) {
    if (!seed?.seedVersion || !seed?.bank) throw new Error('Base integrada no válida');
    const applied = await this.getMeta('seedVersion'); if (applied === seed.seedVersion) return;
    await this.reconcileCanonicalSeed(seed);
    for (const row of seed.banks) await this.put('banks', row); for (const row of seed.categories) await this.putIfMissing('categories', row.categoryId, row); for (const row of seed.levels) await this.putIfMissing('levels', row.levelKey, row); for (const row of seed.players) await this.putIfMissing('players', row.playerId, row); for (const row of seed.questions) await this.putIfMissing('questions', row.questionKey, row); for (const row of seed.matches) await this.putIfMissing('matches', row.matchId, row); for (const row of seed.participants) await this.putIfMissing('participants', row.matchPlayerId, row); for (const row of seed.attempts) await this.putIfMissing('attempts', row.attemptId, row); for (const row of seed.exposures) await this.putIfMissing('exposures', row.exposureId, row); for (const row of seed.events) await this.putIfMissing('events', row.eventId, row);
    await this.setMeta('seedVersion', seed.seedVersion); await this.setMeta('csvEncoding', 'UTF-8'); await this.setMeta('csvDialect', 'RFC4180-comma-CRLF-doublequote');
  },
  async resetToSeed() { const seed = await loadSeed(); for (const store of DATA_STORES) await this.clear(store); await this.clear('meta'); await this.ensureSeed(seed); await this.setMeta('schemaVersion', SCHEMA_VERSION); return seed; },
  async exportAll() { const result = { schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString() }; for (const store of [...DATA_STORES, 'meta']) result[store] = await this.getAll(store); return result; },
  async importAll(payload, { replace = false } = {}) { if (!payload || !Array.isArray(payload.matches) || !Array.isArray(payload.attempts)) throw new Error('Copia no válida'); if (replace) for (const store of [...DATA_STORES, 'meta']) await this.clear(store); for (const store of DATA_STORES) if (Array.isArray(payload[store])) await this.putMany(store, payload[store]); if (Array.isArray(payload.meta)) await this.putMany('meta', payload.meta); await this.setMeta('schemaVersion', payload.schemaVersion ?? SCHEMA_VERSION); },
};
