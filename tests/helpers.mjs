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
