export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function makeEvent(matchId, seq, type, payload = {}) {
  return {
    eventId: `${matchId}|E${String(seq).padStart(5, '0')}`,
    matchId,
    seq,
    type,
    ts: new Date().toISOString(),
    payload,
  };
}
