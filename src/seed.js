import { csvBool, csvInt, csvList, csvNullableBool, fetchCsv } from './csv.js';
import { EVENT_SCHEMA_VERSION, RULES_VERSION, SCHEMA_VERSION, SEED_FILES } from './config.js';

const required = Object.freeze({
  meta: ['key', 'value'],
  banks: ['bank_id', 'name', 'seed_version', 'question_count', 'level_weights_policy'],
  categories: ['bank_id', 'category_id', 'category_key', 'label', 'color', 'emoji', 'active', 'quesito_default'],
  levels: ['level_key', 'scale_id', 'level_id_local', 'label', 'order', 'probability_weight', 'description'],
  questions: ['bank_id', 'question_id', 'question_key', 'category_id', 'level_key', 'prompt', 'answer', 'explanation', 'status', 'order_key'],
  players: ['player_id', 'name', 'active'],
  matches: ['match_id', 'name', 'bank_id', 'player_ids', 'enabled_category_ids', 'enabled_level_keys', 'rules_version', 'level_weights_json', 'status', 'created_at', 'closed_at', 'close_reason', 'seed', 'source'],
  participants: ['match_player_id', 'match_id', 'player_id', 'seat_no', 'active'],
  attempts: ['attempt_id', 'match_id', 'question_no', 'player_id', 'question_id', 'question_key', 'bank_id', 'category_id', 'level_key', 'result_id', 'computable', 'correct', 'quesito_attempt', 'quesito_won', 'notes', 'active', 'source', 'source_event_id'],
  exposures: ['exposure_id', 'match_id', 'bank_id', 'question_key', 'question_id', 'player_id', 'question_no', 'type', 'counts_as_attempt', 'reason', 'source', 'active', 'source_event_id'],
  events: ['event_id', 'match_id', 'seq', 'timestamp', 'type', 'schema_version', 'action_id', 'idempotency_key', 'payload_json'],
});

function assertColumns(name, rows) {
  const columns = rows.columns ?? Object.keys(rows[0] ?? {});
  const missing = required[name].filter((column) => !columns.includes(column));
  if (missing.length) throw new Error(`${name}: faltan columnas requeridas: ${missing.join(', ')}`);
}

function parseJson(value, label, fallback = {}) {
  if (!value) return fallback;
  try { return JSON.parse(value); }
  catch { throw new Error(`${label}: JSON inválido`); }
}

function mapRows(raw) {
  const metaValues = Object.fromEntries(raw.meta.map((row) => [row.key, row.value]));
  const banks = raw.banks.map((row) => ({ bankId: row.bank_id, name: row.name, seedVersion: row.seed_version, questionCount: csvInt(row.question_count), levelWeightsPolicy: row.level_weights_policy, seedOwned: true }));
  const categories = raw.categories.map((row) => ({ categoryKey: row.category_key, bankId: row.bank_id, categoryId: row.category_id, label: row.label, color: row.color, emoji: row.emoji, active: csvBool(row.active, true), quesitoDefault: csvBool(row.quesito_default, true), seedOwned: true }));
  const levels = raw.levels.map((row) => ({ levelKey: row.level_key, scaleId: row.scale_id, levelIdLocal: row.level_id_local, label: row.label, order: csvInt(row.order), probabilityWeight: csvInt(row.probability_weight), description: row.description, seedOwned: true }));
  const questions = raw.questions.map((row) => ({ questionKey: row.question_key, bankId: row.bank_id, questionId: row.question_id, categoryId: row.category_id, levelKey: row.level_key, prompt: row.prompt, answer: row.answer, explanation: row.explanation, status: row.status, sourceStatus: row.source_status ?? '', randomOrder: csvInt(row.random_order, Number.MAX_SAFE_INTEGER), orderKey: row.order_key, seedOwned: true }));
  const players = raw.players.map((row) => ({ playerId: row.player_id, name: row.name, active: csvBool(row.active, true), seedOwned: true }));
  const matches = raw.matches.map((row) => ({ matchId: row.match_id, name: row.name, bankId: row.bank_id, playerIds: csvList(row.player_ids), enabledCategoryIds: csvList(row.enabled_category_ids), enabledLevelKeys: csvList(row.enabled_level_keys), rulesVersion: row.rules_version, levelWeights: parseJson(row.level_weights_json, `${row.match_id}.level_weights_json`), status: row.status, createdAt: row.created_at || null, closedAt: row.closed_at || null, closeReason: row.close_reason || null, seed: row.seed, source: row.source, seedOwned: true }));
  const participants = raw.participants.map((row) => ({ matchPlayerId: row.match_player_id, matchId: row.match_id, playerId: row.player_id, seatNo: csvInt(row.seat_no), active: csvBool(row.active, true), seedOwned: true }));
  const attempts = raw.attempts.map((row) => ({ attemptId: row.attempt_id, matchId: row.match_id, questionNo: csvInt(row.question_no), playerId: row.player_id, questionId: row.question_id, questionKey: row.question_key, bankId: row.bank_id, categoryId: row.category_id, levelKey: row.level_key, resultId: row.result_id, computable: csvBool(row.computable, true), correct: csvNullableBool(row.correct), quesitoAttempt: csvBool(row.quesito_attempt), quesitoWon: csvBool(row.quesito_won), notes: row.notes, active: csvBool(row.active, true), source: row.source, sourceEventId: row.source_event_id || null, seedOwned: true }));
  const exposures = raw.exposures.map((row) => ({ exposureId: row.exposure_id, matchId: row.match_id || null, bankId: row.bank_id || null, questionKey: row.question_key || null, questionId: row.question_id || null, playerId: row.player_id || null, questionNo: row.question_no ? csvInt(row.question_no) : null, type: row.type, countsAsAttempt: csvBool(row.counts_as_attempt), reason: row.reason, source: row.source, active: csvBool(row.active, true), sourceEventId: row.source_event_id || null, seedOwned: true }));
  const events = raw.events.map((row) => ({ eventId: row.event_id, matchId: row.match_id, seq: csvInt(row.seq), timestamp: row.timestamp, type: row.type, schemaVersion: csvInt(row.schema_version, EVENT_SCHEMA_VERSION), actionId: row.action_id || null, idempotencyKey: row.idempotency_key || null, payload: parseJson(row.payload_json, `${row.event_id}.payload_json`), seedOwned: true }));
  return { seedVersion: metaValues.seed_version, schemaVersion: csvInt(metaValues.schema_version, SCHEMA_VERSION), rulesVersion: metaValues.rules_version || RULES_VERSION, canonicalBankId: metaValues.canonical_bank_id, banks, categories, levels, questions, players, matches, participants, attempts, exposures, events, meta: raw.meta.map((row) => ({ key: row.key, value: row.value })) };
}

function duplicateValues(rows, key) {
  const counts = new Map();
  for (const row of rows) counts.set(row[key], (counts.get(row[key]) ?? 0) + 1);
  return [...counts].filter(([, count]) => count > 1).map(([value]) => value);
}

export function validateSeed(seed) {
  const errors = [];
  const add = (type, id, detail) => errors.push({ type, id: String(id ?? ''), detail });
  if (!seed.seedVersion) add('REQUIRED', 'meta.seed_version', 'Falta seed_version');
  if (seed.schemaVersion !== SCHEMA_VERSION) add('SCHEMA_VERSION', seed.schemaVersion, `Se esperaba ${SCHEMA_VERSION}`);
  const uniqueChecks = [['banks', 'bankId'], ['categories', 'categoryKey'], ['levels', 'levelKey'], ['questions', 'questionKey'], ['players', 'playerId'], ['matches', 'matchId'], ['participants', 'matchPlayerId'], ['attempts', 'attemptId'], ['exposures', 'exposureId'], ['events', 'eventId']];
  for (const [collection, key] of uniqueChecks) for (const id of duplicateValues(seed[collection], key)) add('DUPLICATE_ID', id, `${collection}.${key}`);
  const bankIds = new Set(seed.banks.map((row) => row.bankId));
  const categoryKeys = new Set(seed.categories.map((row) => row.categoryKey));
  const levelKeys = new Set(seed.levels.map((row) => row.levelKey));
  const questionKeys = new Set(seed.questions.map((row) => row.questionKey));
  const playerIds = new Set(seed.players.map((row) => row.playerId));
  const matchIds = new Set(seed.matches.map((row) => row.matchId));
  for (const row of seed.levels) if (!(Number(row.probabilityWeight) > 0)) add('LEVEL_WEIGHT', row.levelKey, 'probability_weight debe ser positivo');
  for (const row of seed.categories) {
    if (!bankIds.has(row.bankId)) add('FK', row.categoryKey, `bank_id ${row.bankId}`);
    if (row.categoryKey !== `${row.bankId}|${row.categoryId}`) add('KEY', row.categoryKey, 'category_key debe ser bank_id|category_id');
  }
  const prompts = new Map();
  const orderKeys = new Set();
  const answerStopwords = new Set(['a', 'de', 'del', 'el', 'en', 'la', 'las', 'los', 'o', 'para', 'por', 'un', 'una', 'y']);
  const normalize = (value) => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const row of seed.questions) {
    for (const field of ['bankId', 'questionId', 'questionKey', 'categoryId', 'levelKey', 'prompt', 'answer', 'explanation', 'status', 'orderKey']) if (!String(row[field] ?? '').trim()) add('REQUIRED', row.questionKey || row.questionId, field);
    if (row.questionKey !== `${row.bankId}|${row.questionId}`) add('KEY', row.questionKey, 'question_key debe ser bank_id|question_id');
    if (!bankIds.has(row.bankId)) add('FK', row.questionKey, `bank_id ${row.bankId}`);
    if (!categoryKeys.has(`${row.bankId}|${row.categoryId}`)) add('FK', row.questionKey, `category_id ${row.categoryId}`);
    if (!levelKeys.has(row.levelKey)) add('FK', row.questionKey, `level_key ${row.levelKey}`);
    if (!['active', 'retired'].includes(row.status)) add('STATUS', row.questionKey, row.status);
    if (!row.prompt.endsWith('?') || row.prompt.length > 220 || row.answer.length > 120 || row.explanation.length > 300) add('EDITORIAL_FORMAT', row.questionKey, 'longitud o interrogación inválida');
    const normalized = `${row.bankId}|${row.prompt.trim().toLocaleLowerCase('es')}`;
    if (prompts.has(normalized)) add('DUPLICATE_PROMPT', row.questionKey, `También ${prompts.get(normalized)}`);
    else prompts.set(normalized, row.questionKey);
    const answerPhrase = normalize(row.answer).split(' ').filter((word) => !answerStopwords.has(word)).join(' ');
    if (answerPhrase.length >= 4 && normalize(row.prompt).includes(answerPhrase)) add('ANSWER_LEAK', row.questionKey, 'La respuesta aparece en el enunciado');
    const orderIdentity = `${row.bankId}|${row.orderKey}`;
    if (orderKeys.has(orderIdentity)) add('DUPLICATE_ORDER', row.questionKey, row.orderKey);
    orderKeys.add(orderIdentity);
  }
  for (const bank of seed.banks) {
    const actual = seed.questions.filter((row) => row.bankId === bank.bankId).length;
    if (actual !== bank.questionCount) add('QUESTION_COUNT', bank.bankId, `${bank.questionCount} declarado; ${actual} real`);
  }
  for (const row of seed.matches) {
    if (!bankIds.has(row.bankId)) add('FK', row.matchId, `bank_id ${row.bankId}`);
    for (const playerId of row.playerIds) if (!playerIds.has(playerId)) add('FK', row.matchId, `player_id ${playerId}`);
    for (const categoryId of row.enabledCategoryIds) if (!categoryKeys.has(`${row.bankId}|${categoryId}`)) add('FK', row.matchId, `category_id ${categoryId}`);
    for (const levelKey of row.enabledLevelKeys) if (!levelKeys.has(levelKey)) add('FK', row.matchId, `level_key ${levelKey}`);
    if (!row.rulesVersion) add('REQUIRED', row.matchId, 'rules_version');
  }
  for (const row of seed.participants) {
    if (!matchIds.has(row.matchId)) add('FK', row.matchPlayerId, `match_id ${row.matchId}`);
    if (!playerIds.has(row.playerId)) add('FK', row.matchPlayerId, `player_id ${row.playerId}`);
  }
  for (const row of seed.attempts) {
    if (!matchIds.has(row.matchId)) add('FK', row.attemptId, `match_id ${row.matchId}`);
    if (!playerIds.has(row.playerId)) add('FK', row.attemptId, `player_id ${row.playerId}`);
    if (!questionKeys.has(row.questionKey)) add('FK', row.attemptId, `question_key ${row.questionKey}`);
    if (!levelKeys.has(row.levelKey)) add('FK', row.attemptId, `level_key ${row.levelKey}`);
  }
  const seqs = new Set();
  for (const row of seed.events) {
    const key = `${row.matchId}|${row.seq}`;
    if (seqs.has(key)) add('DUPLICATE_SEQ', key, row.eventId);
    seqs.add(key);
    if (!matchIds.has(row.matchId)) add('FK', row.eventId, `match_id ${row.matchId}`);
  }
  return { ok: errors.length === 0, errors, counts: { banks: seed.banks.length, categories: seed.categories.length, levels: seed.levels.length, questions: seed.questions.length, players: seed.players.length, matches: seed.matches.length, attempts: seed.attempts.length, events: seed.events.length } };
}

export async function loadSeed() {
  const entries = await Promise.all(Object.entries(SEED_FILES).map(async ([name, paths]) => {
    const parts = await Promise.all(paths.map(fetchCsv));
    const rows = parts.flat();
    rows.columns = parts[0]?.columns ?? Object.keys(parts[0]?.[0] ?? {});
    assertColumns(name, rows);
    return [name, rows];
  }));
  const seed = mapRows(Object.fromEntries(entries));
  const validation = validateSeed(seed);
  if (!validation.ok) throw new Error(`Semilla inválida: ${validation.errors.slice(0, 5).map((error) => `${error.type}:${error.id}`).join('; ')}`);
  return seed;
}

export { required as REQUIRED_COLUMNS };
