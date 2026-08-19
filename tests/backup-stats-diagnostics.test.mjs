import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackup, validateBackup } from '../src/backup.js';
import { diagnose } from '../src/diagnostics.js';
import { makeEvent, EVENT_TYPES } from '../src/domain.js';
import { computeStats, twoProportionPValue, wilsonInterval } from '../src/stats.js';

function snapshot() {
  const match = { matchId: 'M', bankId: 'B', playerIds: ['J1', 'J3'], enabledCategoryIds: ['A'], enabledLevelKeys: ['S|CUR'], levelWeights: { A: { 'S|CUR': 1 } }, status: 'open', source: 'web' };
  const draw = makeEvent({ matchId: 'M', seq: 1, type: EVENT_TYPES.QUESTION_DRAWN, payload: { drawOrdinal: 1, playerId: 'J3', categoryId: 'A', levelKey: 'S|CUR', questionKey: 'B|Q1', quesitoAttempt: true } });
  const result = makeEvent({ matchId: 'M', seq: 2, type: EVENT_TYPES.RESULT_RECORDED, payload: { drawEventId: draw.eventId, playerId: 'J3', categoryId: 'A', levelKey: 'S|CUR', questionKey: 'B|Q1', correct: true, quesitoAttempt: true, quesitoWon: true } });
  return { banks: [{ bankId: 'B', questionCount: 1 }], categories: [{ categoryKey: 'B|A', bankId: 'B', categoryId: 'A', active: true }], levels: [{ levelKey: 'S|CUR', levelIdLocal: 'CUR' }], questions: [{ questionKey: 'B|Q1', bankId: 'B', categoryId: 'A', levelKey: 'S|CUR', status: 'active' }], players: [{ playerId: 'J1' }, { playerId: 'J3' }], matches: [match], participants: [{ matchPlayerId: 'M|J1', matchId: 'M', playerId: 'J1', active: true }, { matchPlayerId: 'M|J3', matchId: 'M', playerId: 'J3', active: true }], attempts: [], exposures: [], events: [draw, result], meta: [{ key: 'schemaVersion', value: 7 }, { key: 'seedVersion', value: 'x' }] };
}

test('backup completo válido sobrevive a serialización y rechaza duplicados antes de escribir', () => {
  const backup = JSON.parse(JSON.stringify(createBackup(snapshot())));
  assert.equal(validateBackup(backup).ok, true);
  backup.events.push({ ...backup.events[0] });
  assert.equal(validateBackup(backup).ok, false);
});

test('estadísticas cuentan resultados activos y excluyen descartes y revertidos', () => {
  const state = snapshot();
  state.events.push(makeEvent({ matchId: 'M', seq: 3, type: EVENT_TYPES.QUESTION_DISCARDED, payload: { drawEventId: 'otro' } }));
  const stats = computeStats(state);
  assert.equal(stats.byPlayer.find((row) => row.playerId === 'J3').attempts, 1);
  assert.equal(stats.byPlayer.find((row) => row.playerId === 'J3').quesitosWon, 1);
  assert.equal(stats.discards, 1);
  assert.equal(stats.byPlayer.find((row) => row.playerId === 'J3').potentialQuesitos, 1);
  assert.equal(stats.byPlayer.find((row) => row.playerId === 'J3').quesitoOpportunityRate, 1);
});

test('intervalos y significación estadística son reproducibles y conservadores', () => {
  const interval = wilsonInterval(5, 10);
  assert.ok(interval.low > 0.2 && interval.high < 0.8);
  assert.ok(twoProportionPValue(90, 100, 50, 100) < 0.05);
  assert.equal(twoProportionPValue(0, 0, 1, 1), 1);
});

test('diagnóstico informa IDs y tipos sin exponer enunciados', () => {
  const state = snapshot();
  assert.equal(diagnose(state).ok, true);
  state.events.push({ ...state.events[0], eventId: 'otro', seq: 1 });
  const result = diagnose(state);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.type === 'DUPLICATE_SEQ'));
  assert.equal(JSON.stringify(result).includes('prompt'), false);
});
