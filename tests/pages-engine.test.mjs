import test from 'node:test';
import assert from 'node:assert/strict';
import { TYPES, appendEvent, deriveState, selectQuestion, globalUsedQuestionKeys, undo, redo, stats, weightsForMatch } from '../src/pages-engine.js';

const seed = {
  questions: [
    {questionKey:'B|Q1',bankId:'B',categoryId:'C',levelKey:'L1',status:'active',randomOrder:2},
    {questionKey:'B|Q2',bankId:'B',categoryId:'C',levelKey:'L1',status:'active',randomOrder:1},
    {questionKey:'B|Q3',bankId:'B',categoryId:'C',levelKey:'L2',status:'active',randomOrder:1},
    {questionKey:'B|OLD',bankId:'B',categoryId:'C',levelKey:'L1',status:'active',randomOrder:0}
  ],
  attempts:[{active:true,computable:true,questionKey:'B|OLD',playerId:'J1',categoryId:'C',levelKey:'L1',correct:true,quesitoAttempt:false,quesitoWon:false,matchId:'H'}],
  exposures:[]
};

function fresh(){
  const match={matchId:'M',bankId:'B',playerIds:['J1','J3'],categoryIds:['C'],levelKeys:['L1','L2'],startingPlayerId:'J3',seed:'seed',levelWeights:{C:{L1:3,L2:1}}};
  return {match,runtime:{schemaVersion:1,matches:[match],events:[]}};
}

test('starting player is explicit and rotation follows selected participants',()=>{
  const {match,runtime}=fresh();
  assert.equal(deriveState(match,runtime.events).currentPlayerId,'J3');
  const draw=appendEvent(runtime,'M',TYPES.QUESTION_DRAWN,{playerId:'J3',categoryId:'C',levelKey:'L1',questionKey:'B|Q2',quesitoAttempt:false});
  appendEvent(runtime,'M',TYPES.ANSWER_REVEALED,{drawEventId:draw.eventId});
  appendEvent(runtime,'M',TYPES.RESULT_RECORDED,{drawEventId:draw.eventId,playerId:'J3',categoryId:'C',levelKey:'L1',correct:true,quesitoAttempt:false,quesitoWon:false});
  assert.equal(deriveState(match,runtime.events).currentPlayerId,'J1');
});

test('historically administered questions are globally excluded',()=>{
  const {runtime}=fresh();
  assert(globalUsedQuestionKeys(seed,runtime).has('B|OLD'));
});

test('level selection is deterministic and question order is stable',()=>{
  const {match,runtime}=fresh();
  const a=selectQuestion(seed,runtime,match,'C');
  const b=selectQuestion(seed,runtime,match,'C');
  assert.equal(a.levelKey,b.levelKey);
  assert.equal(a.question.questionKey,b.question.questionKey);
  if(a.levelKey==='L1') assert.equal(a.question.questionKey,'B|Q2');
  else assert.equal(a.question.questionKey,'B|Q3');
});

test('weights freeze from original bank composition, not remaining stock',()=>{
  const {match}=fresh();
  const weights=weightsForMatch(seed,'B',['C'],['L1','L2']);
  assert.deepEqual(weights,{C:{L1:3,L2:1}});
  assert.deepEqual(match.levelWeights,{C:{L1:3,L2:1}});
});

test('undo and redo restore terminal semantics without forgetting exposure',()=>{
  const {match,runtime}=fresh();
  const action='A';
  const draw=appendEvent(runtime,'M',TYPES.QUESTION_DRAWN,{playerId:'J3',categoryId:'C',levelKey:'L1',questionKey:'B|Q2',quesitoAttempt:true});
  appendEvent(runtime,'M',TYPES.ANSWER_REVEALED,{drawEventId:draw.eventId});
  appendEvent(runtime,'M',TYPES.RESULT_RECORDED,{drawEventId:draw.eventId,playerId:'J3',categoryId:'C',levelKey:'L1',correct:true,quesitoAttempt:true,quesitoWon:true},action);
  assert.equal(deriveState(match,runtime.events).currentDraw,null);
  assert.equal(undo(runtime,'M'),true);
  assert.equal(deriveState(match,runtime.events).currentDraw.questionKey,'B|Q2');
  assert(globalUsedQuestionKeys(seed,runtime).has('B|Q2'));
  assert.equal(redo(runtime,'M'),true);
  assert.equal(deriveState(match,runtime.events).currentDraw,null);
});

test('stats merge historical and local active results',()=>{
  const {runtime}=fresh();
  appendEvent(runtime,'M',TYPES.RESULT_RECORDED,{drawEventId:'x',playerId:'J3',categoryId:'C',levelKey:'L2',correct:false,quesitoAttempt:false,quesitoWon:false});
  const result=stats(seed,runtime);
  assert.equal(result.rows.length,2);
  assert.equal(result.byPlayer.find(x=>x.key==='J1').correct,1);
  assert.equal(result.byPlayer.find(x=>x.key==='J3').wrong,1);
});
