export function pct(value) {
  return `${Math.round((value ?? 0) * 1000) / 10}%`;
}

export function aggregateMatches(matches, events, getActiveEvents) {
  const byMatch = new Map();
  for (const m of matches) byMatch.set(m.matchId, { match: m, events: [] });
  for (const e of events) if (byMatch.has(e.matchId)) byMatch.get(e.matchId).events.push(e);

  const wins = new Map();
  for (const { match, events: matchEvents } of byMatch.values()) {
    if (match.status !== 'closed') continue;
    const active = getActiveEvents(matchEvents).filter((e) => e.type === 'RESULT_RECORDED');
    const scores = new Map();
    for (const e of active) {
      if (!e.payload.quesitoWon) continue;
      const set = scores.get(e.payload.playerId) ?? new Set();
      set.add(e.payload.categoryId);
      scores.set(e.payload.playerId, set);
    }
    const max = Math.max(0, ...[...scores.values()].map((s) => s.size));
    for (const [playerId, set] of scores) {
      if (set.size === max && max > 0) wins.set(playerId, (wins.get(playerId) ?? 0) + 1);
    }
  }
  return wins;
}
