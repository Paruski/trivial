import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function installFileFetch() {
  globalThis.fetch = async (input) => {
    const filename = path.join(root, String(input).replace(/^\.\//, ''));
    try { return new Response(fs.readFileSync(filename), { status: 200 }); }
    catch { return new Response('', { status: 404 }); }
  };
}

export function powerset(values) {
  return Array.from({ length: 2 ** values.length - 1 }, (_, index) => index + 1).map((mask) => values.filter((_, index) => mask & (1 << index)));
}
