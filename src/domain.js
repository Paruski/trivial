export const SCHEMA_VERSION = 1;

export const EVENT_TYPES = Object.freeze({
  MATCH_CREATED: 'MATCH_CREATED',
  TURN_SET: 'TURN_SET',
  QUESTION_DRAWN: 'QUESTION_DRAWN',
  ANSWER_REVEALED: 'ANSWER_REVEALED',
  RESULT_RECORDED: 'RESULT_RECORDED',
  QUESTION_EXPOSED: 'QUESTION_EXPOSED',
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
    if (event.type === EVENT_TYPES.EVENT_REVERTED && event.payload?.targetEventId) {
      reverted.add(event.payload.targetEventId);
    }
    if (event.type === EVENT_TYPES.EVENT_RESTORED && event.payload?.targetEventId) {
      reverted.delete(event.payload.targetEventId);
    }
  }
  return reverted;
}

export function getActiveEvents(events) {
  const reverted = getRevertedEventIds(events);
  return sortEvents(events).filter((e) => !CONTROL_EVENTS.has(e.type) && !reverted.has(e.eventId));
}

export function deriveMatchState(match, events) {
  const active = getActiveEvents(events);
  const state = {
    status: match.status ?? 'open',
    currentPlayerId: match.playerIds?.[0] ?? null,
    currentDraw: null,
    answerRevealed: false,
    results: [],
    quesitosByPlayer: new Map(),
    exposedQuestionKeys: new Set(),
    usedQuestionKeys: new Set(),
    timeline: active,
  };

  for (const event of active) {
    switch (event.type) {
      case EVENT_TYPES.MATCH_CREATED:
        state.currentPlayerId = event.payload?.playerIds?.[0] ?? state.currentPlayerId;
        break;
      case EVENT_TYPES.TURN_SET:
        state.currentPlayerId = event.payload?.playerId ?? state.currentPlayerId;
        break;
      case EVENT_TYPES.QUESTION_DRAWN:
        state.currentDraw = {
          eventId: event.eventId,
          questionKey: event.payload.questionKey,
          playerId: event.payload.playerId,
          categoryId: event.payload.categoryId,
          levelKey: event.payload.levelKey,
        };
        state.answerRevealed = false;
        state.usedQuestionKeys.add(event.payload.questionKey);
        break;
      case EVENT_TYPES.ANSWER_REVEALED:
        if (state.currentDraw && event.payload?.drawEventId === state.currentDraw.eventId) {
          state.answerRevealed = true;
        }
        break;
      case EVENT_TYPES.RESULT_RECORDED: {
        state.results.push(event.payload);
        if (event.payload?.quesitoWon) {
          const set = state.quesitosByPlayer.get(event.payload.playerId) ?? new Set();
          set.add(event.payload.categoryId);
          state.quesitosByPlayer.set(event.payload.playerId, set);
        }
        if (state.currentDraw?.eventId === event.payload?.drawEventId) {
          state.currentDraw = null;
          state.answerRevealed = false;
        }
        break;
      }
      case EVENT_TYPES.QUESTION_EXPOSED:
        state.exposedQuestionKeys.add(event.payload.questionKey);
        state.usedQuestionKeys.add(event.payload.questionKey);
        if (state.currentDraw?.questionKey === event.payload.questionKey) {
          state.currentDraw = null;
          state.answerRevealed = false;
        }
        break;
      case EVENT_TYPES.MATCH_CLOSED:
        state.status = 'closed';
        break;
      default:
        break;
    }
  }
  return state;
}

export function eligibleQuestions({ questions, categoryId, enabledLevelKeys = [], usedQuestionKeys = new Set() }) {
  const levelFilter = new Set(enabledLevelKeys);
  return questions
    .filter((q) => q.status === 'active')
    .filter((q) => (q.categoryIds ?? []).includes(categoryId))
    .filter((q) => levelFilter.size === 0 || levelFilter.has(q.levelKey))
    .filter((q) => !usedQuestionKeys.has(q.questionKey))
    .sort((a, b) => {
      const ao = Number.isFinite(Number(a.randomOrder)) ? Number(a.randomOrder) : Number.MAX_SAFE_INTEGER;
      const bo = Number.isFinite(Number(b.randomOrder)) ? Number(b.randomOrder) : Number.MAX_SAFE_INTEGER;
      return ao - bo || String(a.questionId).localeCompare(String(b.questionId));
    });
}

export function selectNextQuestion(args) {
  return eligibleQuestions(args)[0] ?? null;
}

export function computeStats(matches, events) {
  const matchMap = new Map(matches.map((m) => [m.matchId, m]));
  const activeResults = [];
  const activeEventsByMatch = new Map();

  for (const event of events) {
    if (!activeEventsByMatch.has(event.matchId)) activeEventsByMatch.set(event.matchId, []);
    activeEventsByMatch.get(event.matchId).push(event);
  }

  for (const [matchId, matchEvents] of activeEventsByMatch.entries()) {
    if (!matchMap.has(matchId)) continue;
    for (const event of getActiveEvents(matchEvents)) {
      if (event.type === EVENT_TYPES.RESULT_RECORDED) {
        activeResults.push({ matchId, ...event.payload });
      }
    }
  }

  const byPlayer = new Map();
  const byPlayerCategory = new Map();
  const byPlayerLevel = new Map();

  const ensure = (map, key, seed) => {
    if (!map.has(key)) map.set(key, { ...seed });
    return map.get(key);
  };

  for (const r of activeResults) {
    const p = ensure(byPlayer, r.playerId, { playerId: r.playerId, resolved: 0, correct: 0, wrong: 0, quesitoAttempts: 0, quesitosWon: 0 });
    p.resolved += 1;
    p.correct += r.correct ? 1 : 0;
    p.wrong += r.correct ? 0 : 1;
    p.quesitoAttempts += r.quesitoAttempt ? 1 : 0;
    p.quesitosWon += r.quesitoWon ? 1 : 0;

    const pcKey = `${r.playerId}|${r.categoryId}`;
    const pc = ensure(byPlayerCategory, pcKey, { playerId: r.playerId, categoryId: r.categoryId, resolved: 0, correct: 0, wrong: 0, quesitoAttempts: 0, quesitosWon: 0 });
    pc.resolved += 1;
    pc.correct += r.correct ? 1 : 0;
    pc.wrong += r.correct ? 0 : 1;
    pc.quesitoAttempts += r.quesitoAttempt ? 1 : 0;
    pc.quesitosWon += r.quesitoWon ? 1 : 0;

    const plKey = `${r.playerId}|${r.levelKey}`;
    const pl = ensure(byPlayerLevel, plKey, { playerId: r.playerId, levelKey: r.levelKey, resolved: 0, correct: 0, wrong: 0 });
    pl.resolved += 1;
    pl.correct += r.correct ? 1 : 0;
    pl.wrong += r.correct ? 0 : 1;
  }

  for (const map of [byPlayer, byPlayerCategory, byPlayerLevel]) {
    for (const row of map.values()) {
      row.precision = row.resolved ? row.correct / row.resolved : 0;
    }
  }

  return {
    byPlayer: [...byPlayer.values()].sort((a, b) => a.playerId.localeCompare(b.playerId)),
    byPlayerCategory: [...byPlayerCategory.values()],
    byPlayerLevel: [...byPlayerLevel.values()],
  };
}

export function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}
