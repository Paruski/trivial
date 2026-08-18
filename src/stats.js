import { EVENT_TYPES } from './config.js';
import { getActiveEvents } from './domain.js';

export function pct(value) {
  return `${Math.round((value ?? 0) * 1000) / 10}%`;
}

function increment(map, key, seed, attempt) {
  if (!map.has(key)) map.set(key, { ...seed, attempts: 0, correct: 0, wrong: 0, quesitoAttempts: 0, quesitosWon: 0 });
  const row = map.get(key);
  row.attempts += 1;
  row.correct += attempt.correct ? 1 : 0;
  row.wrong += attempt.correct ? 0 : 1;
  row.quesitoAttempts += attempt.quesitoAttempt ? 1 : 0;
  row.quesitosWon += attempt.quesitoWon ? 1 : 0;
}

export function computableAttempts({ attempts, events }) {
  const historical = attempts.filter((attempt) => attempt.source === 'historical_seed' && attempt.active !== false && attempt.computable !== false && typeof attempt.correct === 'boolean');
  const fromEvents = [];
  const grouped = new Map();
  for (const event of events) {
    if (!grouped.has(event.matchId)) grouped.set(event.matchId, []);
    grouped.get(event.matchId).push(event);
  }
  for (const matchEvents of grouped.values()) for (const event of getActiveEvents(matchEvents)) {
    if (event.type !== EVENT_TYPES.RESULT_RECORDED || typeof event.payload?.correct !== 'boolean') continue;
    fromEvents.push({
      attemptId: `event:${event.eventId}`,
      matchId: event.matchId,
      playerId: event.payload.playerId,
      categoryId: event.payload.categoryId,
      levelKey: event.payload.levelKey,
      questionKey: event.payload.questionKey,
      correct: event.payload.correct,
      quesitoAttempt: Boolean(event.payload.quesitoAttempt),
      quesitoWon: Boolean(event.payload.quesitoWon),
      timestamp: event.timestamp,
    });
  }
  return [...historical, ...fromEvents];
}

export function computeStats({ matches, participants, attempts, events }) {
  const resolved = computableAttempts({ attempts, events });
  const byPlayer = new Map();
  const byPlayerCategory = new Map();
  const byPlayerLevel = new Map();
  const byMatchPlayer = new Map();
  for (const attempt of resolved) {
    increment(byPlayer, attempt.playerId, { playerId: attempt.playerId }, attempt);
    increment(byPlayerCategory, `${attempt.playerId}|${attempt.categoryId}`, { playerId: attempt.playerId, categoryId: attempt.categoryId }, attempt);
    increment(byPlayerLevel, `${attempt.playerId}|${attempt.levelKey}`, { playerId: attempt.playerId, levelKey: attempt.levelKey }, attempt);
    increment(byMatchPlayer, `${attempt.matchId}|${attempt.playerId}`, { matchId: attempt.matchId, playerId: attempt.playerId }, attempt);
  }
  const matchCounts = new Map();
  for (const participant of participants.filter((row) => row.active !== false)) matchCounts.set(participant.playerId, (matchCounts.get(participant.playerId) ?? 0) + 1);
  for (const [playerId, count] of matchCounts) {
    if (!byPlayer.has(playerId)) byPlayer.set(playerId, { playerId, attempts: 0, correct: 0, wrong: 0, quesitoAttempts: 0, quesitosWon: 0 });
    byPlayer.get(playerId).matches = count;
  }
  for (const map of [byPlayer, byPlayerCategory, byPlayerLevel, byMatchPlayer]) for (const row of map.values()) row.accuracy = row.attempts ? row.correct / row.attempts : 0;
  const discards = events.filter((event) => event.type === EVENT_TYPES.QUESTION_DISCARDED).length;
  const observed = new Map();
  for (const event of events.filter((item) => item.type === EVENT_TYPES.QUESTION_DRAWN)) {
    const key = `${event.matchId}|${event.payload.categoryId}|${event.payload.levelKey}`;
    observed.set(key, (observed.get(key) ?? 0) + 1);
  }
  const levelDistribution = [];
  for (const match of matches) for (const categoryId of match.enabledCategoryIds ?? []) {
    const weights = match.levelWeights?.[categoryId] ?? {};
    const totalTarget = Object.values(weights).reduce((sum, weight) => sum + Number(weight), 0);
    const totalObserved = [...observed].filter(([key]) => key.startsWith(`${match.matchId}|${categoryId}|`)).reduce((sum, [, count]) => sum + count, 0);
    for (const [levelKey, weight] of Object.entries(weights)) levelDistribution.push({ matchId: match.matchId, categoryId, levelKey, observed: observed.get(`${match.matchId}|${categoryId}|${levelKey}`) ?? 0, observedShare: totalObserved ? (observed.get(`${match.matchId}|${categoryId}|${levelKey}`) ?? 0) / totalObserved : 0, targetShare: totalTarget ? Number(weight) / totalTarget : 0 });
  }
  const temporal = new Map();
  for (const attempt of resolved) {
    const day = String(attempt.timestamp ?? matches.find((match) => match.matchId === attempt.matchId)?.createdAt ?? 'sin-fecha').slice(0, 10);
    const key = `${day}|${attempt.playerId}`;
    if (!temporal.has(key)) temporal.set(key, { day, playerId: attempt.playerId, attempts: 0, correct: 0 });
    temporal.get(key).attempts += 1;
    temporal.get(key).correct += attempt.correct ? 1 : 0;
  }
  return { byPlayer: [...byPlayer.values()], byPlayerCategory: [...byPlayerCategory.values()], byPlayerLevel: [...byPlayerLevel.values()], byMatchPlayer: [...byMatchPlayer.values()], levelDistribution, discards, temporal: [...temporal.values()].sort((a, b) => a.day.localeCompare(b.day)) };
}
