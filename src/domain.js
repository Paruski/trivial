export const SCHEMA_VERSION = 4;

export const EVENT_TYPES = Object.freeze({
  MATCH_CREATED: 'MATCH_CREATED',
  QUESTION_DRAWN: 'QUESTION_DRAWN',
  ANSWER_REVEALED: 'ANSWER_REVEALED',
  RESULT_RECORDED: 'RESULT_RECORDED',
  QUESTION_DISCARDED: 'QUESTION_DISCARDED',
  MATCH_CLOSED: 'MATCH_CLOSED',
  EVENT_REVERTED: 'EVENT_REVERTED',
  EVENT_RESTORED: 'EVENT_RESTORED',
});

const CONTROL_EVENTS = new Set([EVENT_TYPES.EVENT_REVERTED, EVENT_TYPES.EVENT_RESTORED]);

export function sortEvents(events) {
  return [...events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || String(a.eventId).localeCompare(String(b.eventId)));
}

export function getRevertedEventIds(events) {
  const reverted = new Set();
  for (const event of sortEvents(events)) {
    if (event.type === EVENT_TYPES.EVENT_REVERTED && event.payload?.targetEventId) reverted.add(event.payload.targetEventId);
    if (event.type === EVENT_TYPES.EVENT_RESTORED && event.payload?.targetEventId) reverted.delete(event.payload.targetEventId);
  }
  return reverted;
}

export function getActiveEvents(events) {
  const reverted = getRevertedEventIds(events);
  return sortEvents(events).filter((e) => !CONTROL_EVENTS.has(e.type) && !reverted.has(e.eventId));
}

export function deriveLiveState(match, events) {
  const active = getActiveEvents(events);
  const state = { status: match.status ?? 'open', currentDraw: null, answerRevealed: false, timeline: active };
  for (const event of active) {
    switch (event.type) {
      case EVENT_TYPES.QUESTION_DRAWN:
        state.currentDraw = { eventId: event.eventId, questionKey: event.payload.questionKey, playerId: event.payload.playerId, categoryId: event.payload.categoryId, levelKey: event.payload.levelKey, quesitoAttempt: Boolean(event.payload.quesitoAttempt), drawOrdinal: event.payload.drawOrdinal };
        state.answerRevealed = false;
        break;
      case EVENT_TYPES.ANSWER_REVEALED:
        if (state.currentDraw?.eventId === event.payload?.drawEventId) state.answerRevealed = true;
        break;
      case EVENT_TYPES.RESULT_RECORDED:
      case EVENT_TYPES.QUESTION_DISCARDED:
        if (state.currentDraw?.eventId === event.payload?.drawEventId) { state.currentDraw = null; state.answerRevealed = false; }
        break;
      case EVENT_TYPES.MATCH_CLOSED: state.status = 'closed'; break;
      default: break;
    }
  }
  return state;
}

export function hash32(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

export function deterministicUnit(seedText) {
  let x = hash32(seedText) || 0x6d2b79f5;
  x += 0x6d2b79f5;
  let t = x;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function makeMatchSeed({ matchId, playerIds, categoryIds, levelKeys, bankId }) {
  return hash32(`${matchId}|${bankId}|${playerIds.join(',')}|${categoryIds.join(',')}|${levelKeys.join(',')}`).toString(16).padStart(8, '0');
}

export function baseLevelWeightsForCategory({ questions, categoryId, enabledLevelKeys }) {
  const enabled = new Set(enabledLevelKeys);
  const counts = new Map();
  for (const q of questions) {
    if (q.categoryId !== categoryId || !enabled.has(q.levelKey)) continue;
    counts.set(q.levelKey, (counts.get(q.levelKey) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function freezeLevelWeights({ questions, categoryIds, enabledLevelKeys }) {
  return Object.fromEntries(categoryIds.map((categoryId) => [categoryId, baseLevelWeightsForCategory({ questions, categoryId, enabledLevelKeys })]));
}

export function chooseLevelForDraw({ matchSeed, drawOrdinal, categoryId, playerId, enabledLevelKeys, frozenWeights, questions }) {
  const available = enabledLevelKeys.filter((levelKey) => questions.some((q) => q.categoryId === categoryId && q.levelKey === levelKey && q.status === 'active'));
  if (!available.length) return null;
  const weights = frozenWeights?.[categoryId] ?? baseLevelWeightsForCategory({ questions, categoryId, enabledLevelKeys });
  const weighted = available.map((levelKey) => ({ levelKey, weight: Math.max(0, Number(weights[levelKey] ?? 0)) }));
  let total = weighted.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) { for (const item of weighted) item.weight = 1; total = weighted.length; }
  const unit = deterministicUnit(`${matchSeed}|level|${drawOrdinal}|${categoryId}|${playerId}`);
  let cursor = unit * total;
  for (const item of weighted) {
    if (cursor < item.weight) return { levelKey: item.levelKey, unit, weights: Object.fromEntries(weighted.map((w) => [w.levelKey, w.weight])) };
    cursor -= item.weight;
  }
  const last = weighted.at(-1);
  return { levelKey: last.levelKey, unit, weights: Object.fromEntries(weighted.map((w) => [w.levelKey, w.weight])) };
}

export function nextQuestionWithinLevel({ questions, categoryId, levelKey }) {
  return questions.filter((q) => q.status === 'active' && q.categoryId === categoryId && q.levelKey === levelKey).sort((a, b) => {
    const ao = Number.isFinite(Number(a.randomOrder)) ? Number(a.randomOrder) : Number.MAX_SAFE_INTEGER;
    const bo = Number.isFinite(Number(b.randomOrder)) ? Number(b.randomOrder) : Number.MAX_SAFE_INTEGER;
    return ao - bo || String(a.questionId).localeCompare(String(b.questionId));
  })[0] ?? null;
}

export function selectReplacementQuestion({ questions, categoryId, levelKey }) { return nextQuestionWithinLevel({ questions, categoryId, levelKey }); }

export function selectQuestionForDraw(args) {
  const level = chooseLevelForDraw(args);
  if (!level) return null;
  const question = nextQuestionWithinLevel({ questions: args.questions, categoryId: args.categoryId, levelKey: level.levelKey });
  return question ? { question, ...level } : null;
}

export function activeComputableAttempts(attempts) { return attempts.filter((a) => a.active !== false && a.computable !== false && a.correct !== null && a.correct !== undefined); }

export function nextPlayerId(match, attempts) {
  const ids = match.playerIds ?? [];
  if (!ids.length) return null;
  const completed = activeComputableAttempts(attempts).filter((a) => a.matchId === match.matchId).length;
  return ids[completed % ids.length];
}

export function quesitosByPlayer(attempts) {
  const map = new Map();
  for (const a of attempts) {
    if (a.active === false || !a.quesitoWon) continue;
    const set = map.get(a.playerId) ?? new Set(); set.add(a.categoryId); map.set(a.playerId, set);
  }
  return map;
}

export function computeStats(attempts, matches = []) {
  const active = activeComputableAttempts(attempts);
  const byPlayer = new Map(), byPlayerCategory = new Map(), byPlayerLevel = new Map(), byMatchPlayer = new Map();
  const ensure = (map, key, seed) => { if (!map.has(key)) map.set(key, { ...seed }); return map.get(key); };
  const bump = (row, a) => { row.resolved += 1; row.correct += a.correct ? 1 : 0; row.wrong += a.correct ? 0 : 1; row.quesitoAttempts = (row.quesitoAttempts ?? 0) + (a.quesitoAttempt ? 1 : 0); row.quesitosWon = (row.quesitosWon ?? 0) + (a.quesitoWon ? 1 : 0); };
  for (const a of active) {
    bump(ensure(byPlayer, a.playerId, { playerId: a.playerId, resolved: 0, correct: 0, wrong: 0, quesitoAttempts: 0, quesitosWon: 0 }), a);
    bump(ensure(byPlayerCategory, `${a.playerId}|${a.categoryId}`, { playerId: a.playerId, categoryId: a.categoryId, resolved: 0, correct: 0, wrong: 0, quesitoAttempts: 0, quesitosWon: 0 }), a);
    bump(ensure(byPlayerLevel, `${a.playerId}|${a.levelKey}`, { playerId: a.playerId, levelKey: a.levelKey, resolved: 0, correct: 0, wrong: 0, quesitoAttempts: 0, quesitosWon: 0 }), a);
    bump(ensure(byMatchPlayer, `${a.matchId}|${a.playerId}`, { matchId: a.matchId, playerId: a.playerId, resolved: 0, correct: 0, wrong: 0, quesitoAttempts: 0, quesitosWon: 0 }), a);
  }
  for (const map of [byPlayer, byPlayerCategory, byPlayerLevel, byMatchPlayer]) for (const row of map.values()) row.precision = row.resolved ? row.correct / row.resolved : 0;
  const matchMap = new Map(matches.map((m) => [m.matchId, m]));
  const wins = new Map(), grouped = new Map();
  for (const row of byMatchPlayer.values()) { if (!grouped.has(row.matchId)) grouped.set(row.matchId, []); grouped.get(row.matchId).push(row); }
  for (const [matchId, rows] of grouped.entries()) {
    if (matchMap.get(matchId)?.status !== 'closed' || !rows.length) continue;
    const best = Math.max(...rows.map((r) => r.quesitosWon));
    for (const row of rows.filter((r) => r.quesitosWon === best)) wins.set(row.playerId, (wins.get(row.playerId) ?? 0) + 1);
  }
  return { byPlayer: [...byPlayer.values()], byPlayerCategory: [...byPlayerCategory.values()], byPlayerLevel: [...byPlayerLevel.values()], byMatchPlayer: [...byMatchPlayer.values()], wins };
}
