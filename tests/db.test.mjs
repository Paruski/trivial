import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { installFileFetch } from './helpers.mjs';
import { EVENT_TYPES } from '../src/config.js';

globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;
globalThis.BroadcastChannel = undefined;
installFileFetch();

const { db, openDatabase } = await import('../src/db.js?integration');

function deleteDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('trivial-pages');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

test('IndexedDB: migración, atomicidad, idempotencia, concurrencia, recuperación y reset', async () => {
  await deleteDatabase();
  await db.init();
  const database = await openDatabase();
  const transaction = database.transaction('events', 'readonly');
  assert.equal(transaction.objectStore('events').index('matchSeq').unique, true);
  assert.equal((await db.get('meta', 'schemaVersion')).value, 7);

  const match = { matchId: 'M-DB', name: 'DB', bankId: 'B2026-08-18', playerIds: ['J1', 'J3'], enabledCategoryIds: ['AL'], enabledLevelKeys: ['S_DIFICULTAD_TRIVIAL_V1|CUR'], rulesVersion: 'trivial-rules-3.0.0', levelWeights: { AL: { 'S_DIFICULTAD_TRIVIAL_V1|CUR': 70 } }, seed: 'x', status: 'open', createdAt: new Date().toISOString(), source: 'web', seedOwned: false };
  await db.createMatch(match, match.playerIds.map((playerId, index) => ({ matchPlayerId: `${match.matchId}|${playerId}`, matchId: match.matchId, playerId, seatNo: index + 1, active: true })), { type: EVENT_TYPES.MATCH_CREATED, idempotencyKey: 'M-DB:created', payload: {} });

  await Promise.all([1, 2].map(() => db.commitMatch(match.matchId, [{ type: EVENT_TYPES.QUESTION_DRAWN, idempotencyKey: 'M-DB:draw:1', payload: { drawOrdinal: 1, playerId: 'J3', categoryId: 'AL', levelKey: 'S_DIFICULTAD_TRIVIAL_V1|CUR', questionKey: 'B2026-08-18|AL-001' } }])));
  let events = await db.eventsForMatch(match.matchId);
  assert.equal(events.filter((event) => event.type === EVENT_TYPES.QUESTION_DRAWN).length, 1, 'doble clic idempotente');

  await Promise.all([db.commitMatch(match.matchId, [{ type: EVENT_TYPES.ANSWER_REVEALED, idempotencyKey: 'M-DB:a', payload: {} }]), db.commitMatch(match.matchId, [{ type: EVENT_TYPES.ANSWER_REVEALED, idempotencyKey: 'M-DB:b', payload: {} }])]);
  events = await db.eventsForMatch(match.matchId);
  assert.equal(new Set(events.map((event) => event.seq)).size, events.length, 'seq únicos con escrituras concurrentes');

  const beforeFailure = events.length;
  await assert.rejects(db.commitMatch(match.matchId, () => { throw new Error('fallo simulado'); }), /fallo simulado/);
  assert.equal((await db.eventsForMatch(match.matchId)).length, beforeFailure, 'un fallo no deja escritura parcial');

  await db.commitDiscard(match.matchId, 'B2026-08-18|AL-001', [{ type: EVENT_TYPES.QUESTION_DISCARDED, idempotencyKey: 'M-DB:discard', payload: { drawEventId: 'M-DB|E000002', questionKey: 'B2026-08-18|AL-001' } }]);
  assert.equal((await db.get('questions', 'B2026-08-18|AL-001')).retiredLocally, true, 'evento y retirada local se confirman atómicamente');

  const snapshot = await db.snapshot();
  const corrupt = structuredClone(snapshot);
  corrupt.events.push({ ...corrupt.events[0] });
  await assert.rejects(db.replaceAll(corrupt));
  assert.ok(await db.get('matches', match.matchId), 'una importación fallida revierte el clear completo');

  await db.resetToSeed();
  assert.equal(await db.get('matches', match.matchId), undefined);
  assert.equal((await db.getAll('questions')).length, 726);
  assert.equal((await db.get('meta', 'seedVersion')).value, '2026-08-19.5');
  assert.notEqual((await db.get('questions', 'B2026-08-18|AL-001')).retiredLocally, true, 'reset recupera exactamente el CSV');
});
