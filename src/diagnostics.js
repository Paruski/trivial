import { EVENT_TYPES, SCHEMA_VERSION } from './config.js';
import { deriveLiveState, getActiveEvents } from './domain.js';

export function diagnose(snapshot) {
  const errors = [];
  const add = (type, id, detail) => errors.push({ type, id: String(id ?? ''), detail });
  const duplicate = (rows, key, type = 'DUPLICATE_ID') => {
    const seen = new Set();
    for (const row of rows) { const value = row[key]; if (seen.has(value)) add(type, value, key); seen.add(value); }
  };
  for (const [collection, key] of [['banks', 'bankId'], ['categories', 'categoryKey'], ['levels', 'levelKey'], ['questions', 'questionKey'], ['players', 'playerId'], ['matches', 'matchId'], ['participants', 'matchPlayerId'], ['attempts', 'attemptId'], ['exposures', 'exposureId'], ['events', 'eventId']]) duplicate(snapshot[collection], key);
  const bankIds = new Set(snapshot.banks.map((row) => row.bankId));
  const playerIds = new Set(snapshot.players.map((row) => row.playerId));
  const questionKeys = new Set(snapshot.questions.map((row) => row.questionKey));
  const matchIds = new Set(snapshot.matches.map((row) => row.matchId));
  for (const bank of snapshot.banks) {
    const actual = snapshot.questions.filter((question) => question.bankId === bank.bankId).length;
    if (actual !== bank.questionCount) add('QUESTION_COUNT', bank.bankId, `${bank.questionCount}/${actual}`);
  }
  for (const question of snapshot.questions) if (!bankIds.has(question.bankId)) add('FK_QUESTION_BANK', question.questionKey, question.bankId);
  const seqs = new Set();
  const byMatch = new Map();
  for (const event of snapshot.events) {
    const seqKey = `${event.matchId}|${event.seq}`;
    if (seqs.has(seqKey)) add('DUPLICATE_SEQ', seqKey, event.eventId);
    seqs.add(seqKey);
    if (!matchIds.has(event.matchId)) add('ORPHAN_EVENT', event.eventId, event.matchId);
    if (!byMatch.has(event.matchId)) byMatch.set(event.matchId, []);
    byMatch.get(event.matchId).push(event);
  }
  for (const attempt of snapshot.attempts) {
    if (!matchIds.has(attempt.matchId)) add('ORPHAN_ATTEMPT', attempt.attemptId, attempt.matchId);
    if (!playerIds.has(attempt.playerId)) add('ORPHAN_ATTEMPT', attempt.attemptId, attempt.playerId);
    if (!questionKeys.has(attempt.questionKey)) add('ORPHAN_ATTEMPT', attempt.attemptId, attempt.questionKey);
  }
  for (const match of snapshot.matches) {
    const events = byMatch.get(match.matchId) ?? [];
    const active = getActiveEvents(events);
    const draws = new Map(active.filter((event) => event.type === EVENT_TYPES.QUESTION_DRAWN).map((event) => [event.eventId, event]));
    const terminals = new Map();
    for (const event of active.filter((item) => [EVENT_TYPES.RESULT_RECORDED, EVENT_TYPES.QUESTION_DISCARDED].includes(item.type))) {
      const drawId = event.payload?.drawEventId;
      if (!draws.has(drawId)) add('ORPHAN_RESULT', event.eventId, drawId);
      terminals.set(drawId, (terminals.get(drawId) ?? 0) + 1);
      if (terminals.get(drawId) > 1) add('DUPLICATE_TERMINAL', drawId, event.eventId);
      if (event.type === EVENT_TYPES.RESULT_RECORDED && event.payload?.quesitoWon && (!event.payload?.quesitoAttempt || !event.payload?.correct)) add('QUESITO_INCOHERENT', event.eventId, 'quesitoWon exige intento de quesito y acierto');
    }
    const pending = [...draws].filter(([drawId]) => !terminals.has(drawId));
    const live = deriveLiveState(match, events);
    if (pending.length > 1 || (pending.length === 1) !== Boolean(live.currentDraw)) add('PENDING_INCOHERENT', match.matchId, pending.map(([id]) => id).join(','));
    const won = new Set();
    for (const event of active.filter((item) => item.type === EVENT_TYPES.RESULT_RECORDED && item.payload?.quesitoWon)) {
      const key = `${event.payload.playerId}|${event.payload.categoryId}`;
      if (won.has(key)) add('QUESITO_DUPLICATE', match.matchId, key);
      won.add(key);
    }
  }
  const meta = Object.fromEntries(snapshot.meta.map((row) => [row.key, row.value]));
  if (Number(meta.schemaVersion ?? meta.schema_version) !== SCHEMA_VERSION) add('SCHEMA_VERSION', meta.schemaVersion ?? meta.schema_version, `esperado ${SCHEMA_VERSION}`);
  if (!meta.seedVersion && !meta.seed_version) add('SEED_VERSION', 'meta', 'ausente');
  return { ok: errors.length === 0, errors, summary: { questionCount: snapshot.questions.length, matchCount: snapshot.matches.length, eventCount: snapshot.events.length, seedVersion: meta.seedVersion ?? meta.seed_version, schemaVersion: Number(meta.schemaVersion ?? meta.schema_version) } };
}
