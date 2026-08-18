import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../src/csv.js';
import { SEED_FILES } from '../src/config.js';
import { serializeCsv } from './csv-utils.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [...new Set(Object.values(SEED_FILES).flat().map((file) => file.replace(/^\.\//, ''))), 'templates/question-bank.csv'];
for (const relative of files) {
  const filename = path.join(root, relative);
  const rows = parseCsv(fs.readFileSync(filename, 'utf8'));
  if (relative.includes('questions-') && !rows[0].includes('order_key')) {
    rows[0].push('order_key');
    const bank = rows[0].indexOf('bank_id');
    const question = rows[0].indexOf('question_id');
    const order = rows[0].indexOf('random_order');
    for (const row of rows.slice(1)) row.push(`${row[bank]}|${String(row[order]).padStart(6, '0')}|${row[question]}`);
  }
  fs.writeFileSync(filename, serializeCsv(rows), 'utf8');
}
console.log(`Normalizados ${files.length} CSV en UTF-8 sin BOM, comillas dobles y CRLF.`);
