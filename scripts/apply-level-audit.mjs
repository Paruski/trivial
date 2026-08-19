import fs from 'node:fs';
import { parseCsv, rowsToObjects } from '../src/csv.js';
import { serializeCsv } from './csv-utils.mjs';

const auditedLevels = {
  AL: { CUR: ['AL-103', 'AL-105'], NIC: ['AL-111'] },
  LI: { AUT: ['LI-057', 'LI-082', 'LI-095'], NIC: ['LI-104'] },
  FI: { CUR: ['FI-098', 'FI-099', 'FI-104'], AUT: ['FI-115', 'FI-116', 'FI-117', 'FI-121'] },
  HI: { CUR: ['HI-092', 'HI-098', 'HI-112'], NIC: ['HI-097'] },
  IN: { AUT: ['IN-070', 'IN-081', 'IN-082', 'IN-094'] },
  NE: { AUT: ['NE-049'] },
};

for (const [categoryId, changes] of Object.entries(auditedLevels)) {
  const filename = new URL(`../data/questions-${categoryId}.csv`, import.meta.url);
  const parsed = parseCsv(fs.readFileSync(filename, 'utf8'));
  const headers = parsed[0];
  const rows = rowsToObjects(parsed);
  const intended = new Map(Object.entries(changes).flatMap(([levelId, ids]) => ids.map((id) => [id, levelId])));
  for (const row of rows) {
    const levelId = intended.get(row.question_id);
    if (levelId) row.level_key = `S_DIFICULTAD_TRIVIAL_V1|${levelId}`;
  }
  const missing = [...intended.keys()].filter((id) => !rows.some((row) => row.question_id === id));
  if (missing.length) throw new Error(`${categoryId}: IDs no encontrados: ${missing.join(', ')}`);
  fs.writeFileSync(filename, serializeCsv([headers, ...rows.map((row) => headers.map((header) => row[header]))]), 'utf8');
}

const levelsFile = new URL('../data/levels.csv', import.meta.url);
const levelRows = rowsToObjects(parseCsv(fs.readFileSync(levelsFile, 'utf8')));
const levelHeaders = ['level_key', 'scale_id', 'level_id_local', 'label', 'order', 'probability_weight', 'description'];
const weights = { CUR: '70', AUT: '20', NIC: '10' };
for (const row of levelRows) row.probability_weight = weights[row.level_id_local] ?? row.probability_weight ?? '1';
fs.writeFileSync(levelsFile, serializeCsv([levelHeaders, ...levelRows.map((row) => levelHeaders.map((header) => row[header]))]), 'utf8');

console.log('Auditoría de niveles aplicada a las seis categorías.');
