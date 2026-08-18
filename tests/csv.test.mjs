import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decodeCsvBytes, parseCsv, rowsToObjects } from '../src/csv.js';
import { SEED_FILES } from '../src/config.js';
import { loadSeed, validateSeed } from '../src/seed.js';
import { installFileFetch, root } from './helpers.mjs';

installFileFetch();

test('todos los CSV canónicos son UTF-8 sin BOM, CRLF y RFC 4180 estructural', () => {
  for (const relative of Object.values(SEED_FILES).flat()) {
    const bytes = fs.readFileSync(path.join(root, relative));
    const rows = parseCsv(decodeCsvBytes(bytes, relative));
    assert.ok(rows.length >= 1, relative);
    rowsToObjects(rows);
  }
});

test('el parser rechaza BOM, LF suelto, cabeceras inestables y filas rotas', () => {
  assert.throws(() => decodeCsvBytes(Buffer.from('\ufeff"a"\r\n"b"\r\n')), /BOM/);
  assert.throws(() => decodeCsvBytes(Buffer.from('"a"\n"b"\n')), /CRLF/);
  assert.throws(() => rowsToObjects(parseCsv('"Á"\r\n"x"\r\n')), /cabeceras/);
  assert.throws(() => rowsToObjects(parseCsv('"a","b"\r\n"x"\r\n')), /campos/);
});

test('la semilla canónica completa pasa IDs, FKs, duplicados, obligatorios y conteos', async () => {
  const seed = await loadSeed();
  const result = validateSeed(seed);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.counts.questions, 126);
  assert.equal(new Set(seed.questions.map((question) => question.questionKey)).size, 126);
  assert.equal(seed.questions.some((question) => question.status === 'discarded'), false);
  assert.equal(seed.questions.every((question) => question.questionKey === `${question.bankId}|${question.questionId}` && question.orderKey), true);
});

test('la semilla limpia no conserva descartes ni notas de rectificación resuelta', async () => {
  const seed = await loadSeed();
  assert.equal(seed.exposures.length, 0);
  assert.equal(seed.attempts.some((attempt) => /correcci[oó]n|rectific|no era pregunta/i.test(attempt.notes ?? '')), false);
});
