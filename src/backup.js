import { DATA_STORES, SCHEMA_VERSION } from './config.js';

export function createBackup(snapshot) {
  return { format: 'trivial-local-backup', formatVersion: 1, schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), ...snapshot };
}

function duplicates(rows, key) {
  const seen = new Set();
  return rows.map((row) => row?.[key]).filter((value) => { const repeated = seen.has(value); seen.add(value); return repeated; });
}

export function validateBackup(payload) {
  const errors = [];
  const add = (type, id, detail) => errors.push({ type, id: String(id ?? ''), detail });
  if (!payload || payload.format !== 'trivial-local-backup' || payload.formatVersion !== 1) add('FORMAT', 'backup', 'Formato o versión no reconocidos');
  if (Number(payload?.schemaVersion) !== SCHEMA_VERSION) add('SCHEMA_VERSION', payload?.schemaVersion, `Se requiere exactamente ${SCHEMA_VERSION}`);
  for (const store of [...DATA_STORES, 'meta']) if (!Array.isArray(payload?.[store])) add('REQUIRED', store, 'Debe ser un array');
  if (errors.length) return { ok: false, errors };
  const ids = { banks: 'bankId', categories: 'categoryKey', levels: 'levelKey', questions: 'questionKey', players: 'playerId', matches: 'matchId', participants: 'matchPlayerId', attempts: 'attemptId', exposures: 'exposureId', events: 'eventId', meta: 'key' };
  for (const [store, key] of Object.entries(ids)) for (const id of duplicates(payload[store], key)) add('DUPLICATE_ID', id, `${store}.${key}`);
  const matchIds = new Set(payload.matches.map((row) => row.matchId));
  const playerIds = new Set(payload.players.map((row) => row.playerId));
  const questionKeys = new Set(payload.questions.map((row) => row.questionKey));
  const eventIds = new Set(payload.events.map((row) => row.eventId));
  const seqs = new Set();
  const idempotency = new Set();
  for (const event of payload.events) {
    const seqKey = `${event.matchId}|${event.seq}`;
    if (seqs.has(seqKey)) add('DUPLICATE_SEQ', seqKey, event.eventId);
    seqs.add(seqKey);
    if (!matchIds.has(event.matchId)) add('ORPHAN_EVENT', event.eventId, event.matchId);
    if (event.idempotencyKey) {
      if (idempotency.has(event.idempotencyKey)) add('DUPLICATE_IDEMPOTENCY', event.eventId, event.idempotencyKey);
      idempotency.add(event.idempotencyKey);
    }
    const targets = event.payload?.targetEventIds ?? (event.payload?.targetEventId ? [event.payload.targetEventId] : []);
    for (const target of targets) if (!eventIds.has(target)) add('ORPHAN_CONTROL', event.eventId, target);
  }
  for (const participant of payload.participants) {
    if (!matchIds.has(participant.matchId)) add('ORPHAN_PARTICIPANT', participant.matchPlayerId, participant.matchId);
    if (!playerIds.has(participant.playerId)) add('ORPHAN_PARTICIPANT', participant.matchPlayerId, participant.playerId);
  }
  for (const attempt of payload.attempts) {
    if (!matchIds.has(attempt.matchId)) add('ORPHAN_ATTEMPT', attempt.attemptId, attempt.matchId);
    if (!questionKeys.has(attempt.questionKey)) add('ORPHAN_ATTEMPT', attempt.attemptId, attempt.questionKey);
  }
  return { ok: errors.length === 0, errors };
}
