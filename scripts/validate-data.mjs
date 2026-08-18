import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSeed, validateSeed } from '../src/seed.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.fetch = async (input) => {
  const filename = path.join(root, String(input).replace(/^\.\//, ''));
  try { return new Response(fs.readFileSync(filename), { status: 200 }); }
  catch { return new Response('', { status: 404 }); }
};

const seed = await loadSeed();
const result = validateSeed(seed);
if (!result.ok) {
  for (const error of result.errors) console.error(`${error.type}\t${error.id}\t${error.detail}`);
  process.exitCode = 1;
} else console.log(`Semilla válida: ${result.counts.questions} preguntas, ${result.counts.banks} banco(s), seed ${seed.seedVersion}, schema ${seed.schemaVersion}.`);
