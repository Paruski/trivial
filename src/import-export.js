import { makeId, SCHEMA_VERSION } from './domain.js';

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else {
      if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
      else field += ch;
    }
  }
  if (field.length || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows.filter((r) => r.some((v) => v !== ''));
}

function normalizeHeader(s) {
  return String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

export function importBankFromCsv(text, name = 'Banco importado') {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('El CSV no contiene preguntas');
  const headers = rows[0].map(normalizeHeader);
  const get = (obj, ...keys) => {
    for (const key of keys) if (obj[key] !== undefined && obj[key] !== '') return obj[key];
    return '';
  };
  const bankId = `bank_${crypto.randomUUID()}`;
  const categoryMap = new Map();
  const levelMap = new Map();
  const questions = [];

  for (const values of rows.slice(1)) {
    const obj = Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']));
    const questionId = get(obj, 'question_id', 'id', 'pregunta_id');
    const prompt = get(obj, 'pregunta', 'question', 'prompt');
    const answer = get(obj, 'respuesta', 'answer');
    if (!questionId || !prompt || !answer) continue;

    const categoryId = get(obj, 'category_id', 'categoria_id', 'categoria', 'category') || 'GENERAL';
    const categoryLabel = get(obj, 'categoria', 'category') || categoryId;
    categoryMap.set(categoryId, { categoryId, label: categoryLabel });

    const levelLocal = get(obj, 'level_id', 'nivel_id', 'dificultad', 'nivel', 'level') || 'UNSPECIFIED';
    const levelLabel = get(obj, 'dificultad', 'nivel', 'level') || levelLocal;
    const levelKey = `default|${levelLocal}`;
    levelMap.set(levelKey, { levelKey, scaleId: 'default', levelIdLocal: levelLocal, label: levelLabel });

    const rawStatus = get(obj, 'estado', 'status', 'bank_status').toLowerCase();
    const status = ['descartada', 'discarded'].includes(rawStatus) ? 'discarded' : (['administrada', 'administered', 'retired'].includes(rawStatus) ? 'retired' : 'active');

    questions.push({
      questionKey: `${bankId}|${questionId}`,
      bankId,
      questionId,
      prompt,
      answer,
      explanation: get(obj, 'explicacion_breve', 'explicacion', 'explanation'),
      categoryIds: [categoryId],
      levelKey,
      randomOrder: Number(get(obj, 'orden_aleatorio', 'random_order')) || null,
      status,
      sourceStatus: rawStatus || null,
      importedAt: new Date().toISOString(),
    });
  }

  if (!questions.length) throw new Error('No se encontraron filas con ID, pregunta y respuesta');
  return {
    bank: {
      bankId,
      name,
      createdAt: new Date().toISOString(),
      schemaVersion: SCHEMA_VERSION,
      categories: [...categoryMap.values()],
      levels: [...levelMap.values()],
    },
    questions,
  };
}

export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCsv(filename, rows) {
  const escape = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const text = rows.map((r) => r.map(escape).join(',')).join('\n');
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function makeEvent(matchId, seq, type, payload = {}) {
  return { eventId: makeId('evt'), matchId, seq, type, ts: new Date().toISOString(), payload };
}
