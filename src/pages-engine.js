export const TYPES = Object.freeze({ MATCH_CREATED:'MATCH_CREATED', QUESTION_DRAWN:'QUESTION_DRAWN', ANSWER_REVEALED:'ANSWER_REVEALED', RESULT_RECORDED:'RESULT_RECORDED', QUESTION_EXPOSED:'QUESTION_EXPOSED', MATCH_CLOSED:'MATCH_CLOSED', EVENT_REVERTED:'EVENT_REVERTED', EVENT_RESTORED:'EVENT_RESTORED' });

export function sortEvents(events){ return [...events].sort((a,b)=>(a.seq??0)-(b.seq??0)||String(a.eventId).localeCompare(String(b.eventId))); }

export function revertedIds(events){
  const reverted=new Set();
  for(const event of sortEvents(events)){
    const ids=event.payload?.targetEventIds??[];
    if(event.type===TYPES.EVENT_REVERTED) ids.forEach(id=>reverted.add(id));
    if(event.type===TYPES.EVENT_RESTORED) ids.forEach(id=>reverted.delete(id));
  }
  return reverted;
}

export function activeEvents(events){
  const reverted=revertedIds(events);
  return sortEvents(events).filter(event=>![TYPES.EVENT_REVERTED,TYPES.EVENT_RESTORED].includes(event.type)&&!reverted.has(event.eventId));
}

export function nextPlayer(match, playerId){
  const ids=match.playerIds;
  if(!ids?.length) return null;
  const index=Math.max(0, ids.indexOf(playerId));
  return ids[(index+1)%ids.length];
}

export function deriveState(match, events){
  const state={ status:'open', currentPlayerId:match.startingPlayerId, currentDraw:null, answerRevealed:false, close:null, quesitosByPlayer:new Map() };
  for(const event of activeEvents(events)){
    const p=event.payload??{};
    if(event.type===TYPES.QUESTION_DRAWN){ state.currentPlayerId=p.playerId; state.currentDraw={eventId:event.eventId,...p}; state.answerRevealed=false; }
    else if(event.type===TYPES.ANSWER_REVEALED && state.currentDraw?.eventId===p.drawEventId) state.answerRevealed=true;
    else if(event.type===TYPES.RESULT_RECORDED){
      if(p.quesitoWon){ const set=state.quesitosByPlayer.get(p.playerId)??new Set(); set.add(p.categoryId); state.quesitosByPlayer.set(p.playerId,set); }
      if(state.currentDraw?.eventId===p.drawEventId){ const turn=state.currentDraw.playerId; state.currentDraw=null; state.answerRevealed=false; state.currentPlayerId=nextPlayer(match,turn); }
    } else if(event.type===TYPES.QUESTION_EXPOSED && state.currentDraw?.eventId===p.drawEventId){ state.currentDraw=null; state.answerRevealed=false; }
    else if(event.type===TYPES.MATCH_CLOSED){ state.status='closed'; state.close=p; state.currentDraw=null; }
  }
  return state;
}

export function deterministicUnit(seed, ordinal, playerId, categoryId){
  const text=`${seed}|${ordinal}|${playerId}|${categoryId}`;
  let hash=2166136261;
  for(let i=0;i<text.length;i+=1){ hash^=text.charCodeAt(i); hash=Math.imul(hash,16777619); }
  return (hash>>>0)/4294967296;
}

export function globalUsedQuestionKeys(seed, runtime){
  const used=new Set(seed.questions.filter(q=>q.status!=='active').map(q=>q.questionKey));
  for(const attempt of seed.attempts.filter(x=>x.active)) if(attempt.questionKey) used.add(attempt.questionKey);
  for(const exposure of seed.exposures.filter(x=>x.active)) if(exposure.questionKey) used.add(exposure.questionKey);
  for(const event of runtime.events){
    if(event.type===TYPES.QUESTION_DRAWN && event.payload?.questionKey) used.add(event.payload.questionKey);
    if(event.type===TYPES.QUESTION_EXPOSED && event.payload?.questionKey) used.add(event.payload.questionKey);
  }
  return used;
}

export function weightsForMatch(seed, bankId, categoryIds, levelKeys){
  const result={};
  for(const categoryId of categoryIds){
    result[categoryId]={};
    for(const levelKey of levelKeys){
      result[categoryId][levelKey]=seed.questions.filter(q=>q.bankId===bankId&&q.categoryId===categoryId&&q.levelKey===levelKey).length;
    }
  }
  return result;
}

export function selectQuestion(seed, runtime, match, categoryId, preferredLevel=null){
  const events=runtime.events.filter(e=>e.matchId===match.matchId);
  const ordinal=events.filter(e=>e.type===TYPES.QUESTION_DRAWN).length+1;
  const used=globalUsedQuestionKeys(seed,runtime);
  const base=seed.questions.filter(q=>q.bankId===match.bankId&&q.categoryId===categoryId&&q.status==='active'&&!used.has(q.questionKey));
  const byLevel=new Map(match.levelKeys.map(key=>[key,base.filter(q=>q.levelKey===key).sort((a,b)=>(a.randomOrder??999999)-(b.randomOrder??999999)||a.questionKey.localeCompare(b.questionKey))]));
  const currentPlayerId=deriveState(match,events).currentPlayerId;
  if(preferredLevel && byLevel.get(preferredLevel)?.length){
    return {question:byLevel.get(preferredLevel)[0], levelKey:preferredLevel, unit:deterministicUnit(match.seed,ordinal,currentPlayerId,categoryId), effectiveWeights:{[preferredLevel]:1}, ordinal, reason:'same_level_replacement'};
  }
  const available=match.levelKeys.filter(key=>byLevel.get(key)?.length);
  if(!available.length) return null;
  let weighted=available.map(key=>[key,Math.max(0,Number(match.levelWeights?.[categoryId]?.[key]??0))]);
  if(weighted.reduce((s,[,w])=>s+w,0)<=0) weighted=available.map(key=>[key,1]);
  const unit=deterministicUnit(match.seed,ordinal,currentPlayerId,categoryId);
  const total=weighted.reduce((s,[,w])=>s+w,0);
  let cursor=unit*total;
  let chosen=weighted.at(-1)[0];
  for(const [key,weight] of weighted){ if(cursor<weight){ chosen=key; break; } cursor-=weight; }
  return {question:byLevel.get(chosen)[0], levelKey:chosen, unit, effectiveWeights:Object.fromEntries(weighted), ordinal, reason:'weighted'};
}

export function appendEvent(runtime, matchId, type, payload, actionId=crypto.randomUUID()){
  const seq=Math.max(0,...runtime.events.filter(e=>e.matchId===matchId).map(e=>e.seq??0))+1;
  const event={eventId:`E-${crypto.randomUUID()}`,matchId,seq,timestamp:new Date().toISOString(),type,actionId,payload};
  runtime.events.push(event);
  return event;
}

export function canUndo(events){ return activeEvents(events).some(e=>[TYPES.RESULT_RECORDED,TYPES.QUESTION_EXPOSED,TYPES.MATCH_CLOSED].includes(e.type)); }
export function canRedo(events){ const reverted=revertedIds(events); return events.some(e=>e.type===TYPES.EVENT_REVERTED&&(e.payload?.targetEventIds??[]).some(id=>reverted.has(id))); }

export function undo(runtime,matchId){
  const events=runtime.events.filter(e=>e.matchId===matchId); const active=activeEvents(events);
  const candidate=[...active].reverse().find(e=>[TYPES.RESULT_RECORDED,TYPES.QUESTION_EXPOSED,TYPES.MATCH_CLOSED].includes(e.type));
  if(!candidate) return false;
  const targets=active.filter(e=>e.actionId===candidate.actionId&&[TYPES.RESULT_RECORDED,TYPES.QUESTION_EXPOSED,TYPES.QUESTION_DRAWN,TYPES.MATCH_CLOSED].includes(e.type)).map(e=>e.eventId);
  appendEvent(runtime,matchId,TYPES.EVENT_REVERTED,{targetEventIds:targets,label:candidate.type}); return true;
}

export function redo(runtime,matchId){
  const events=runtime.events.filter(e=>e.matchId===matchId); const reverted=revertedIds(events);
  const control=[...events].reverse().find(e=>e.type===TYPES.EVENT_REVERTED&&(e.payload?.targetEventIds??[]).some(id=>reverted.has(id)));
  if(!control) return false;
  appendEvent(runtime,matchId,TYPES.EVENT_RESTORED,{targetEventIds:control.payload.targetEventIds}); return true;
}

export function stats(seed,runtime){
  const rows=[];
  for(const a of seed.attempts) if(a.active&&a.computable&&a.correct!==null) rows.push({playerId:a.playerId,categoryId:a.categoryId,levelKey:a.levelKey,correct:a.correct,quesitoAttempt:a.quesitoAttempt,quesitoWon:a.quesitoWon,matchId:a.matchId});
  for(const match of runtime.matches){
    for(const e of activeEvents(runtime.events.filter(x=>x.matchId===match.matchId))) if(e.type===TYPES.RESULT_RECORDED) rows.push({matchId:match.matchId,...e.payload});
  }
  const aggregate=(keyFn)=>{ const map=new Map(); for(const r of rows){ const key=keyFn(r); const x=map.get(key)??{key,attempts:0,correct:0,wrong:0,quesitoAttempts:0,quesitosWon:0}; x.attempts++; x.correct+=r.correct?1:0; x.wrong+=r.correct?0:1; x.quesitoAttempts+=r.quesitoAttempt?1:0; x.quesitosWon+=r.quesitoWon?1:0; map.set(key,x);} return [...map.values()].map(x=>({...x,accuracy:x.attempts?x.correct/x.attempts:0})); };
  return {rows,byPlayer:aggregate(r=>r.playerId),byPlayerCategory:aggregate(r=>`${r.playerId}|${r.categoryId}`),byPlayerLevel:aggregate(r=>`${r.playerId}|${r.levelKey}`)};
}
