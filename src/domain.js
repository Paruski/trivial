import { EVENT_SCHEMA_VERSION, EVENT_TYPES, RULES_VERSION, SCHEMA_VERSION } from './config.js';

export { EVENT_TYPES, RULES_VERSION, SCHEMA_VERSION };

const CONTROL_EVENTS = new Set([EVENT_TYPES.EVENT_REVERTED, EVENT_TYPES.EVENT_RESTORED]);
const REVERSIBLE_EVENTS = new Set([EVENT_TYPES.RESULT_RECORDED, EVENT_TYPES.QUESTION_DISCARDED, EVENT_TYPES.MATCH_CLOSED]);

export function sortEvents(events) {
  return [...events].sort((a, b) => Number(a.seq) - Number(b.seq) || String(a.eventId).localeCompare(String(b.eventId)));
}

function targetIds(event) {
  const many = event.payload?.targetEventIds;
  if (Array.isArray(many)) return many.filter(Boolean);
  return event.payload?.targetEventId ? [event.payload.targetEventId] : [];
}

export function getRevertedEventIds(events) {
  const reverted = new Set();
  for (const event of sortEvents(events)) {
    if (event.type === EVENT_TYPES.EVENT_REVERTED) for (const id of targetIds(event)) reverted.add(id);
    if (event.type === EVENT_TYPES.EVENT_RESTORED) for (const id of targetIds(event)) reverted.delete(id);
  }
  return reverted;
}

export function getActiveEvents(events) {
  const reverted = getRevertedEventIds(events);
  return sortEvents(events).filter((event) => !CONTROL_EVENTS.has(event.type) && !reverted.has(event.eventId));
}

export function seenQuestionKeys(events) {
  return new Set(events.filter((event) => event.type === EVENT_TYPES.QUESTION_DRAWN && event.payload?.questionKey).map((event) => event.payload.questionKey));
}

export function deriveLiveState(match, events) {
  const active = getActiveEvents(events);
  const state = { status: match.status ?? 'open', currentDraw: null, answerRevealed: false, close: null, timeline: active };
  for (const event of active) {
    switch (event.type) {
      case EVENT_TYPES.QUESTION_DRAWN:
        state.currentDraw = {
          eventId: event.eventId,
          actionId: event.actionId,
          playerId: event.payload.playerId,
          categoryId: event.payload.categoryId,
          levelKey: event.payload.levelKey,
          questionKey: event.payload.questionKey,
          quesitoAttempt: Boolean(event.payload.quesitoAttempt),
          drawOrdinal: Number(event.payload.drawOrdinal),
        };
        state.answerRevealed = false;
        break;
      case EVENT_TYPES.ANSWER_REVEALED:
        if (state.currentDraw?.eventId === event.payload?.drawEventId) state.answerRevealed = true;
        break;
      case EVENT_TYPES.RESULT_RECORDED:
      case EVENT_TYPES.QUESTION_DISCARDED:
        if (state.currentDraw?.eventId === event.payload?.drawEventId) {
          state.currentDraw = null;
          state.answerRevealed = false;
        }
        break;
      case EVENT_TYPES.MATCH_CLOSED:
        state.status = 'closed';
        state.close = event.payload;
        break;
      default:
        break;
    }
  }
  return state;
}

export function hash32(text) {
  let hash = 0x811c9dc5;
  for (const char of String(text)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function deterministicUnit(seedText) {
  let value = hash32(seedText) || 0x6d2b79f5;
  value += 0x6d2b79f5;
  let mixed = value;
  mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
  mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
  return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
}

export function makeMatchSeed({ matchId, playerIds, categoryIds, levelKeys, bankId }) {
  return hash32(`${matchId}|${bankId}|${playerIds.join(',')}|${categoryIds.join(',')}|${levelKeys.join(',')}`).toString(16).padStart(8, '0');
}

export function originalLevelWeightsForCategory({ questions, bankId, categoryId, enabledLevelKeys }) {
  const enabled = new Set(enabledLevelKeys);
  const counts = new Map();
  for (const question of questions) {
    if (question.bankId !== bankId || question.categoryId !== categoryId || !enabled.has(question.levelKey)) continue;
    counts.set(question.levelKey, (counts.get(question.levelKey) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

export function freezeLevelWeights({ questions, bankId, categoryIds, enabledLevelKeys }) {
  return Object.fromEntries(categoryIds.map((categoryId) => [categoryId, originalLevelWeightsForCategory({ questions, bankId, categoryId, enabledLevelKeys })]));
}

export function availableQuestions({ questions, bankId, categoryId, enabledLevelKeys, seenKeys = new Set() }) {
  const enabled = new Set(enabledLevelKeys);
  return questions.filter((question) => question.bankId === bankId && question.categoryId === categoryId && enabled.has(question.levelKey) && question.status === 'active' && !seenKeys.has(question.questionKey));
}

export function validateMatchConfiguration({ bankId, playerIds, categoryIds, levelKeys, questions, availablePlayerIds }) {
  const errors = [];
  if (!bankId) errors.push('Selecciona un banco.');
  if (playerIds.length < 1 || playerIds.length > 3) errors.push('Selecciona entre 1 y 3 jugadores.');
  if (new Set(playerIds).size !== playerIds.length || playerIds.some((id) => !availablePlayerIds.includes(id))) errors.push('La selección de jugadores no es válida.');
  if (!categoryIds.length) errors.push('Selecciona al menos una categoría.');
  if (!levelKeys.length) errors.push('Selecciona al menos un nivel.');
  const emptyCategoryIds = categoryIds.filter((categoryId) => !questions.some((question) => question.bankId === bankId && question.categoryId === categoryId && levelKeys.includes(question.levelKey) && question.status === 'active'));
  if (emptyCategoryIds.length) errors.push(`Sin stock para: ${emptyCategoryIds.join(', ')}.`);
  return { ok: errors.length === 0, errors, emptyCategoryIds };
}

export function chooseLevelForDraw({ matchSeed, drawOrdinal, categoryId, playerId, enabledLevelKeys, frozenWeights, questions }) {
  const availableLevels = enabledLevelKeys.filter((levelKey) => questions.some((question) => question.levelKey === levelKey));
  if (!availableLevels.length) return null;
  const base = frozenWeights?.[categoryId] ?? {};
  const weighted = availableLevels.map((levelKey) => ({ levelKey, weight: Math.max(0, Number(base[levelKey] ?? 0)) }));
  let total = weighted.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) {
    for (const item of weighted) item.weight = 1;
    total = weighted.length;
  }
  const randomUnit = deterministicUnit(`${matchSeed}|${drawOrdinal}|${playerId}|${categoryId}`);
  let cursor = randomUnit * total;
  for (const item of weighted) {
    if (cursor < item.weight) return { levelKey: item.levelKey, randomUnit, effectiveWeights: Object.fromEntries(weighted.map(({ levelKey, weight }) => [levelKey, weight])) };
    cursor -= item.weight;
  }
  const last = weighted.at(-1);
  return { levelKey: last.levelKey, randomUnit, effectiveWeights: Object.fromEntries(weighted.map(({ levelKey, weight }) => [levelKey, weight])) };
}

export function stableQuestionCompare(left, right) {
  return String(left.orderKey).localeCompare(String(right.orderKey)) || String(left.questionKey).localeCompare(String(right.questionKey));
}

export function nextQuestionWithinLevel({ questions, levelKey }) {
  return questions.filter((question) => question.levelKey === levelKey).sort(stableQuestionCompare)[0] ?? null;
}

export function selectQuestionForDraw({ questions, categoryId, playerId, enabledLevelKeys, frozenWeights, matchSeed, drawOrdinal }) {
  const level = chooseLevelForDraw({ questions, categoryId, playerId, enabledLevelKeys, frozenWeights, matchSeed, drawOrdinal });
  if (!level) return null;
  const question = nextQuestionWithinLevel({ questions, levelKey: level.levelKey });
  return question ? { question, ...level } : null;
}

export function selectReplacementQuestion(args) {
  const sameLevel = nextQuestionWithinLevel({ questions: args.questions, levelKey: args.previousLevelKey });
  if (sameLevel) {
    const randomUnit = deterministicUnit(`${args.matchSeed}|${args.drawOrdinal}|${args.playerId}|${args.categoryId}|replacement`);
    return { question: sameLevel, levelKey: args.previousLevelKey, randomUnit, effectiveWeights: { [args.previousLevelKey]: Number(args.frozenWeights?.[args.categoryId]?.[args.previousLevelKey] ?? 1) } };
  }
  return selectQuestionForDraw(args);
}

export function drawOrdinal(events) {
  return events.filter((event) => event.type === EVENT_TYPES.QUESTION_DRAWN).length + 1;
}

export function resultEvents(events) {
  return getActiveEvents(events).filter((event) => event.type === EVENT_TYPES.RESULT_RECORDED);
}

export function quesitosByPlayer(eventsOrAttempts) {
  const map = new Map();
  for (const item of eventsOrAttempts) {
    const payload = item.type === EVENT_TYPES.RESULT_RECORDED ? item.payload : item;
    if (item.active === false || !payload?.quesitoWon) continue;
    const set = map.get(payload.playerId) ?? new Set();
    set.add(payload.categoryId);
    map.set(payload.playerId, set);
  }
  return map;
}

export function winnersForClose(match, events) {
  const quesitos = quesitosByPlayer(resultEvents(events));
  const scores = match.playerIds.map((playerId) => ({ playerId, score: quesitos.get(playerId)?.size ?? 0 }));
  const maximum = Math.max(0, ...scores.map(({ score }) => score));
  return scores.filter(({ score }) => score === maximum).map(({ playerId }) => playerId);
}

export function hasNormalVictory(match, events, playerId) {
  const owned = quesitosByPlayer(resultEvents(events)).get(playerId) ?? new Set();
  return match.enabledCategoryIds.every((categoryId) => owned.has(categoryId));
}

export function undoCandidate(events) {
  const active = getActiveEvents(events);
  const candidate = [...active].reverse().find((event) => REVERSIBLE_EVENTS.has(event.type));
  if (!candidate) return null;
  const actionId = candidate.actionId;
  const group = actionId ? active.filter((event) => event.actionId === actionId) : [candidate];
  return { actionId, targetEventIds: group.map((event) => event.eventId), label: candidate.type };
}

export function redoCandidate(events) {
  const sorted = sortEvents(events);
  const lastControl = [...sorted].reverse().find((event) => CONTROL_EVENTS.has(event.type));
  if (!lastControl || lastControl.type !== EVENT_TYPES.EVENT_REVERTED) return null;
  const after = sorted.filter((event) => event.seq > lastControl.seq && !CONTROL_EVENTS.has(event.type));
  if (after.length) return null;
  return { targetEventIds: targetIds(lastControl), label: lastControl.payload?.label ?? 'acción' };
}

export function makeEvent({ matchId, seq, type, payload = {}, timestamp = new Date().toISOString(), actionId = null, idempotencyKey = null }) {
  return {
    eventId: `${matchId}|E${String(seq).padStart(6, '0')}`,
    matchId,
    seq,
    timestamp,
    type,
    schemaVersion: EVENT_SCHEMA_VERSION,
    actionId,
    idempotencyKey,
    payload,
  };
}
