export function parseCsv(text) {
  const input = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\r') {
      if (input[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else if (ch === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (quoted) throw new Error('CSV inválido: comillas sin cerrar');
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v !== ''));
}

export function rowsToObjects(rows) {
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.replace(/^\uFEFF/, ''));
  if (new Set(headers).size !== headers.length) throw new Error('CSV inválido: cabeceras duplicadas');
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

export async function fetchCsv(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`No se pudo cargar ${path} (${response.status})`);
  const bytes = await response.arrayBuffer();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error(`${path} no está codificado en UTF-8 válido`); }
  return rowsToObjects(parseCsv(text));
}

export function csvBool(value, fallback = false) {
  const s = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'si', 'sí'].includes(s)) return true;
  if (['false', '0', 'no'].includes(s)) return false;
  return fallback;
}

export function csvNullableBool(value) {
  const s = String(value ?? '').trim();
  return s === '' ? null : csvBool(s);
}

export function csvInt(value, fallback = 0) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

export function csvList(value) {
  return String(value ?? '').split(';').map((s) => s.trim()).filter(Boolean);
}
