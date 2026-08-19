import { EVENT_TYPES } from './config.js';
import { getActiveEvents } from './domain.js';

export function pct(value) {
  return `${Math.round((value ?? 0) * 1000) / 10}%`;
}

export function wilsonInterval(successes, total, z = 1.959963984540054) {
  if (!total) return { low: 0, high: 0, confidence: 0.95 };
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total) / denominator;
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin), confidence: 0.95 };
}

function erf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

export function twoProportionPValue(aSuccess, aTotal, bSuccess, bTotal) {
  if (!aTotal || !bTotal) return 1;
  const pooled = (aSuccess + bSuccess) / (aTotal + bTotal);
  const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / aTotal + 1 / bTotal));
  if (!standardError) return 1;
  const z = Math.abs(aSuccess / aTotal - bSuccess / bTotal) / standardError;
  return Math.max(0, Math.min(1, 1 - erf(z / Math.SQRT2)));
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

function finalize(rows) {
  for (const row of rows) {
    row.accuracy = row.attempts ? row.correct / row.attempts : 0;
    row.accuracyCi = wilsonInterval(row.correct, row.attempts);
    row.quesitoRate = row.quesitoAttempts ? row.quesitosWon / row.quesitoAttempts : 0;
    row.quesitoCi = wilsonInterval(row.quesitosWon, row.quesitoAttempts);
  }
  return rows;
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
  const byCategory = new Map();
  const byLevel = new Map();
  for (const attempt of resolved) {
    increment(byPlayer, attempt.playerId, { playerId: attempt.playerId }, attempt);
    increment(byPlayerCategory, `${attempt.playerId}|${attempt.categoryId}`, { playerId: attempt.playerId, categoryId: attempt.categoryId }, attempt);
    increment(byPlayerLevel, `${attempt.playerId}|${attempt.levelKey}`, { playerId: attempt.playerId, levelKey: attempt.levelKey }, attempt);
    increment(byMatchPlayer, `${attempt.matchId}|${attempt.playerId}`, { matchId: attempt.matchId, playerId: attempt.playerId }, attempt);
    increment(byCategory, attempt.categoryId, { categoryId: attempt.categoryId }, attempt);
    increment(byLevel, attempt.levelKey, { levelKey: attempt.levelKey }, attempt);
  }
  const matchCounts = new Map();
  for (const participant of participants.filter((row) => row.active !== false)) matchCounts.set(participant.playerId, (matchCounts.get(participant.playerId) ?? 0) + 1);
  for (const [playerId, count] of matchCounts) {
    if (!byPlayer.has(playerId)) byPlayer.set(playerId, { playerId, attempts: 0, correct: 0, wrong: 0, quesitoAttempts: 0, quesitosWon: 0 });
    byPlayer.get(playerId).matches = count;
  }
  const potentialQuesitos = new Map();
  for (const participant of participants.filter((row) => row.active !== false)) {
    const match = matches.find((item) => item.matchId === participant.matchId);
    potentialQuesitos.set(participant.playerId, (potentialQuesitos.get(participant.playerId) ?? 0) + (match?.enabledCategoryIds?.length ?? 0));
  }
  for (const row of byPlayer.values()) {
    row.potentialQuesitos = potentialQuesitos.get(row.playerId) ?? 0;
    row.quesitoOpportunityRate = row.potentialQuesitos ? row.quesitosWon / row.potentialQuesitos : 0;
    row.quesitoOpportunityCi = wilsonInterval(row.quesitosWon, row.potentialQuesitos);
  }
  const activeEvents = [...new Set(events.map((event) => event.matchId))].flatMap((matchId) => getActiveEvents(events.filter((event) => event.matchId === matchId)));
  const discards = activeEvents.filter((event) => event.type === EVENT_TYPES.QUESTION_DISCARDED).length;
  const observed = new Map();
  for (const event of activeEvents.filter((item) => item.type === EVENT_TYPES.QUESTION_DRAWN)) {
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
  const playerCategoryRows = finalize([...byPlayerCategory.values()]);
  const significantCategoryLeaders = [];
  for (const categoryId of new Set(playerCategoryRows.map((row) => row.categoryId))) {
    const ranked = playerCategoryRows.filter((row) => row.categoryId === categoryId && row.attempts > 0).sort((a, b) => b.accuracy - a.accuracy || b.attempts - a.attempts);
    if (ranked.length < 2 || ranked[0].accuracy === ranked[1].accuracy) continue;
    const pValue = twoProportionPValue(ranked[0].correct, ranked[0].attempts, ranked[1].correct, ranked[1].attempts);
    if (pValue < 0.05) significantCategoryLeaders.push({ categoryId, playerId: ranked[0].playerId, pValue, alpha: 0.05 });
  }
  return {
    byPlayer: finalize([...byPlayer.values()]),
    byPlayerCategory: playerCategoryRows,
    byPlayerLevel: finalize([...byPlayerLevel.values()]),
    byMatchPlayer: finalize([...byMatchPlayer.values()]),
    byCategory: finalize([...byCategory.values()]),
    byLevel: finalize([...byLevel.values()]),
    significantCategoryLeaders,
    levelDistribution,
    discards,
    temporal: [...temporal.values()].sort((a, b) => a.day.localeCompare(b.day)),
    inference: { confidence: 0.95, alpha: 0.05, interval: 'Wilson', comparison: 'z bilateral de dos proporciones' },
  };
}
