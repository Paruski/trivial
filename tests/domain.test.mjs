import test from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_TYPES, deriveMatchState, getActiveEvents, getRevertedEventIds, selectNextQuestion, computeStats } from '../src/domain.js';

const match = { matchId: 'm1', status: 'open', playerIds: ['p1','p2'] };
const evt = (seq, type, payload={}) => ({ eventId:`e${seq}`, matchId:'m1', seq, type, payload });

test('selectNextQuestion respeta estado, categoria, nivel y orden', () => {
  const questions = [
    {questionKey:'q1',questionId:'1',status:'active',categoryIds:['A'],levelKey:'L1',randomOrder:3},
    {questionKey:'q2',questionId:'2',status:'discarded',categoryIds:['A'],levelKey:'L1',randomOrder:1},
    {questionKey:'q3',questionId:'3',status:'active',categoryIds:['A'],levelKey:'L2',randomOrder:2},
    {questionKey:'q4',questionId:'4',status:'active',categoryIds:['B'],levelKey:'L1',randomOrder:1},
  ];
  const q = selectNextQuestion({questions, categoryId:'A', enabledLevelKeys:['L1'], usedQuestionKeys:new Set()});
  assert.equal(q.questionKey, 'q1');
});

test('deriveMatchState concede quesito y undo revierte resultado', () => {
  const events = [
    evt(1, EVENT_TYPES.MATCH_CREATED, {playerIds:['p1','p2']}),
    evt(2, EVENT_TYPES.QUESTION_DRAWN, {questionKey:'q1',playerId:'p1',categoryId:'A',levelKey:'L1',quesitoAttempt:true}),
    evt(3, EVENT_TYPES.RESULT_RECORDED, {drawEventId:'e2',questionKey:'q1',playerId:'p1',categoryId:'A',levelKey:'L1',correct:true,quesitoAttempt:true,quesitoWon:true}),
    evt(4, EVENT_TYPES.EVENT_REVERTED, {targetEventId:'e3'}),
  ];
  const state = deriveMatchState(match, events);
  assert.equal(state.currentDraw?.quesitoAttempt, true);
  assert.equal(state.results.length, 0);
  assert.equal(state.currentDraw?.questionKey, 'q1');
  assert.equal(state.quesitosByPlayer.get('p1')?.size ?? 0, 0);
});

test('redo vuelve a activar un evento', () => {
  const events = [
    evt(1, EVENT_TYPES.MATCH_CREATED, {playerIds:['p1']}),
    evt(2, EVENT_TYPES.TURN_SET, {playerId:'p1'}),
    evt(3, EVENT_TYPES.EVENT_REVERTED, {targetEventId:'e2'}),
    evt(4, EVENT_TYPES.EVENT_RESTORED, {targetEventId:'e2'}),
  ];
  assert.equal(getRevertedEventIds(events).size, 0);
  assert.ok(getActiveEvents(events).some((e)=>e.eventId==='e2'));
});

test('computeStats excluye eventos revertidos', () => {
  const matches = [{matchId:'m1'}];
  const events = [
    evt(1, EVENT_TYPES.RESULT_RECORDED, {playerId:'p1',categoryId:'A',levelKey:'L1',correct:true,quesitoAttempt:false,quesitoWon:false}),
    evt(2, EVENT_TYPES.RESULT_RECORDED, {playerId:'p1',categoryId:'A',levelKey:'L1',correct:false,quesitoAttempt:false,quesitoWon:false}),
    evt(3, EVENT_TYPES.EVENT_REVERTED, {targetEventId:'e2'}),
  ];
  const stats = computeStats(matches, events);
  assert.equal(stats.byPlayer[0].resolved, 1);
  assert.equal(stats.byPlayer[0].correct, 1);
  assert.equal(stats.byPlayer[0].precision, 1);
});
