export function serializeCsv(rows) {
  const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return `${rows.map((row) => row.map(quote).join(',')).join('\r\n')}\r\n`;
}
