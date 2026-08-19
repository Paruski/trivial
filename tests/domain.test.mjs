import test from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_TYPES, availableQuestions, chooseLevelForDraw, deriveLiveState, deterministicUnit, drawOrdinal, freezeLevelWeights, getActiveEvents, makeEvent, quesitosByPlayer, redoCandidate, seenQuestionKeys, selectQuestionForDraw, selectReplacementQuestion, undoCandidate, validateMatchConfiguration } from '../src/domain.js';
import { powerset } from './helpers.mjs';

const bankId = 'B';
const levels = ['S|CUR', 'S|AUT', 'S|NIC'];
const levelDefinitions = levels.map((levelKey, index) => ({ levelKey, probabilityWeight: [70, 20, 10][index] }));
const categories = ['A', 'B', 'C'];
const players = ['J1', 'J2', 'J3'];
const questions = categories.flatMap((categoryId) => levels.flatMap((levelKey, levelIndex) => Array.from({ length: levelIndex + 1 }, (_, index) => ({ bankId, questionId: `${categoryId}-${levelIndex}-${index}`, questionKey: `${bankId}|${categoryId}-${levelIndex}-${index}`, categoryId, levelKey, status: 'active', orderKey: `${bankId}|${categoryId}|${levelIndex}|${String(index).padStart(3, '0')}` }))));
const match = { matchId: 'M', bankId, playerIds: players, enabledCategoryIds: categories, enabledLevelKeys: levels, seed: 'seed', status: 'open', levelWeights: freezeLevelWeights({ levels: levelDefinitions, categoryIds: categories, enabledLevelKeys: levels }) };

function event(seq, type, payload, extra = {}) { return makeEvent({ matchId: 'M', seq, type, payload, timestamp: `2026-08-19T00:00:0${seq}Z`, ...extra }); }

test('acepta todas las combinaciones de 1–3 jugadores disponibles', () => {
  for (const playerIds of powerset(players)) assert.equal(validateMatchConfiguration({ bankId, playerIds, categoryIds: ['A'], levelKeys: levels, questions, availablePlayerIds: players }).ok, true, playerIds.join(','));
  assert.equal(validateMatchConfiguration({ bankId, playerIds: [], categoryIds: ['A'], levelKeys: levels, questions, availablePlayerIds: players }).ok, false);
  assert.equal(validateMatchConfiguration({ bankId, playerIds: ['J1', 'J1'], categoryIds: ['A'], levelKeys: levels, questions, availablePlayerIds: players }).ok, false);
});

test('acepta todos los subconjuntos no vacíos de categorías y niveles con stock', () => {
  for (const categoryIds of powerset(categories)) for (const levelKeys of powerset(levels)) assert.equal(validateMatchConfiguration({ bankId, playerIds: ['J1'], categoryIds, levelKeys, questions, availablePlayerIds: players }).ok, true, `${categoryIds}/${levelKeys}`);
});

test('el turno se congela al sacar y el jugador se comunica con el resultado', () => {
  const pick = selectQuestionForDraw({ questions, categoryId: 'A', playerId: 'J3', enabledLevelKeys: levels, frozenWeights: match.levelWeights, matchSeed: match.seed, drawOrdinal: 1 });
  const drawn = event(1, EVENT_TYPES.QUESTION_DRAWN, { playerId: 'J3', categoryId: 'A', levelKey: pick.levelKey, questionKey: pick.question.questionKey, quesitoAttempt: false, drawOrdinal: 1 });
  assert.equal(deriveLiveState(match, [drawn]).currentDraw.playerId, 'J3');
  const result = event(2, EVENT_TYPES.RESULT_RECORDED, { drawEventId: drawn.eventId, playerId: 'J1', correct: false });
  assert.equal(deriveLiveState(match, [drawn, result]).currentTurnPlayerId, 'J2');
});

test('no permite conceptualmente una segunda pregunta mientras hay una pendiente', () => {
  const events = [event(1, EVENT_TYPES.QUESTION_DRAWN, { playerId: 'J1', categoryId: 'A', levelKey: levels[0], questionKey: questions[0].questionKey, drawOrdinal: 1 })];
  assert.ok(deriveLiveState(match, events).currentDraw);
  assert.equal(drawOrdinal(events), 2);
});

test('PRNG y sorteo completo son deterministas para semilla e historial iguales', () => {
  assert.equal(deterministicUnit('x'), deterministicUnit('x'));
  const args = { questions, categoryId: 'A', playerId: 'J2', enabledLevelKeys: levels, frozenWeights: match.levelWeights, matchSeed: 'abc', drawOrdinal: 7 };
  assert.deepEqual(selectQuestionForDraw(args), selectQuestionForDraw(args));
});

test('los pesos 70/20/10 se congelan y no bajan al consumir preguntas', () => {
  assert.deepEqual(match.levelWeights.A, { 'S|CUR': 70, 'S|AUT': 20, 'S|NIC': 10 });
  const available = questions.filter((question) => question.categoryId === 'A' && question.questionKey !== 'B|A-2-0');
  const choice = chooseLevelForDraw({ matchSeed: 'z', drawOrdinal: 4, playerId: 'J1', categoryId: 'A', enabledLevelKeys: levels, frozenWeights: match.levelWeights, questions: available });
  assert.deepEqual(choice.effectiveWeights, { 'S|CUR': 70, 'S|AUT': 20, 'S|NIC': 10 });
});

test('un nivel agotado se alerta sin renormalizar los pesos', () => {
  const available = questions.filter((question) => question.categoryId === 'A' && question.levelKey !== 'S|AUT');
  let choice;
  for (let drawOrdinal = 1; drawOrdinal < 100 && !choice?.exhausted; drawOrdinal += 1) choice = chooseLevelForDraw({ matchSeed: 'z', drawOrdinal, playerId: 'J1', categoryId: 'A', enabledLevelKeys: levels, frozenWeights: match.levelWeights, questions: available });
  assert.equal(choice.exhausted, true);
  assert.equal(choice.levelKey, 'S|AUT');
  assert.deepEqual(choice.effectiveWeights, { 'S|CUR': 70, 'S|AUT': 20, 'S|NIC': 10 });
});

test('dentro del nivel se elige el menor order_key estable', () => {
  const pool = questions.filter((question) => question.categoryId === 'A' && question.levelKey === 'S|NIC').reverse();
  const selected = selectQuestionForDraw({ questions: pool, categoryId: 'A', playerId: 'J1', enabledLevelKeys: ['S|NIC'], frozenWeights: match.levelWeights, matchSeed: 'x', drawOrdinal: 1 });
  assert.equal(selected.question.orderKey, [...pool].sort((a, b) => a.orderKey.localeCompare(b.orderKey))[0].orderKey);
});

test('quesito solo se concede en intento acertado y nunca se duplica', () => {
  const results = [event(1, EVENT_TYPES.RESULT_RECORDED, { playerId: 'J1', categoryId: 'A', correct: true, quesitoAttempt: false, quesitoWon: false }), event(2, EVENT_TYPES.RESULT_RECORDED, { playerId: 'J1', categoryId: 'A', correct: true, quesitoAttempt: true, quesitoWon: true })];
  assert.deepEqual([...quesitosByPlayer(results).get('J1')], ['A']);
  assert.equal(quesitosByPlayer(results).get('J1').size, 1);
});

test('el descarte aplica de nuevo el sorteo fijo y determinista', () => {
  const pool = questions.filter((question) => question.categoryId === 'A');
  const replacement = selectReplacementQuestion({ questions: pool, previousLevelKey: 'S|AUT', categoryId: 'A', playerId: 'J1', enabledLevelKeys: levels, frozenWeights: match.levelWeights, matchSeed: 'x', drawOrdinal: 2 });
  assert.deepEqual(replacement, selectReplacementQuestion({ questions: pool, previousLevelKey: 'S|AUT', categoryId: 'A', playerId: 'J1', enabledLevelKeys: levels, frozenWeights: match.levelWeights, matchSeed: 'x', drawOrdinal: 2 }));
  assert.deepEqual(replacement.effectiveWeights, { 'S|CUR': 70, 'S|AUT': 20, 'S|NIC': 10 });
});

test('undo/redo semántico restaura la proyección sin devolver vistas al pool', () => {
  const q1 = questions[0].questionKey, q2 = questions[1].questionKey;
  const events = [event(1, EVENT_TYPES.QUESTION_DRAWN, { playerId: 'J1', categoryId: 'A', levelKey: levels[0], questionKey: q1, drawOrdinal: 1 }, { actionId: 'draw' }), event(2, EVENT_TYPES.QUESTION_DISCARDED, { drawEventId: 'M|E000001', questionKey: q1 }, { actionId: 'discard' }), event(3, EVENT_TYPES.QUESTION_DRAWN, { playerId: 'J1', categoryId: 'A', levelKey: levels[1], questionKey: q2, drawOrdinal: 2 }, { actionId: 'discard' })];
  const undo = undoCandidate(events);
  const reverted = event(4, EVENT_TYPES.EVENT_REVERTED, { targetEventIds: undo.targetEventIds, label: undo.label });
  assert.equal(deriveLiveState(match, [...events, reverted]).currentDraw.questionKey, q1);
  assert.deepEqual(seenQuestionKeys([...events, reverted]), new Set([q1, q2]));
  const redo = redoCandidate([...events, reverted]);
  const restored = event(5, EVENT_TYPES.EVENT_RESTORED, { targetEventIds: redo.targetEventIds });
  assert.equal(deriveLiveState(match, [...events, reverted, restored]).currentDraw.questionKey, q2);
});

test('replay es idempotente y un resultado revertido no computa', () => {
  const drawn = event(1, EVENT_TYPES.QUESTION_DRAWN, { playerId: 'J1', categoryId: 'A', levelKey: levels[0], questionKey: questions[0].questionKey, drawOrdinal: 1 });
  const result = event(2, EVENT_TYPES.RESULT_RECORDED, { drawEventId: drawn.eventId, playerId: 'J1', correct: true }, { actionId: 'result' });
  const revert = event(3, EVENT_TYPES.EVENT_REVERTED, { targetEventIds: [result.eventId] });
  assert.deepEqual(deriveLiveState(match, [drawn, result, revert]), deriveLiveState(match, [drawn, result, revert]));
  assert.equal(getActiveEvents([drawn, result, revert]).includes(result), false);
});

test('el pool es por partida: lo visto en otra partida no consume la semilla', () => {
  const seen = new Set([questions[0].questionKey]);
  assert.equal(availableQuestions({ questions, bankId, categoryId: 'A', enabledLevelKeys: levels, seenKeys: seen }).length, questions.filter((question) => question.categoryId === 'A').length - 1);
  assert.equal(availableQuestions({ questions, bankId, categoryId: 'A', enabledLevelKeys: levels, seenKeys: new Set() }).length, questions.filter((question) => question.categoryId === 'A').length);
});
