const form = document.querySelector('#new-match-form');
const playersRoot = document.querySelector('#new-match-players');

let pendingStartingPlayerId = null;
let explicitStarterId = null;

function makeStarterUi() {
  if (!form || !playersRoot || document.querySelector('#new-match-starter')) return;
  const fieldset = document.createElement('fieldset');
  const legend = document.createElement('legend');
  legend.textContent = 'Empieza la partida';
  const root = document.createElement('div');
  root.id = 'new-match-starter';
  root.className = 'check-grid';
  const help = document.createElement('p');
  help.className = 'muted';
  help.textContent = 'Elige qué participante tendrá el primer turno. Con un único jugador se selecciona automáticamente.';
  fieldset.append(legend, root, help);
  playersRoot.closest('fieldset')?.after(fieldset);
}

function selectedPlayerIds() {
  return [...playersRoot.querySelectorAll('input[name="player"]:checked')].map(input => input.value);
}

function rebuildStarterOptions() {
  makeStarterUi();
  const root = document.querySelector('#new-match-starter');
  if (!root || !playersRoot) return;
  const selected = selectedPlayerIds();
  if (!selected.includes(explicitStarterId)) explicitStarterId = null;
  root.replaceChildren();
  if (!selected.length) {
    const empty = document.createElement('span');
    empty.className = 'muted';
    empty.textContent = 'Selecciona primero los participantes.';
    root.append(empty);
    return;
  }
  for (const playerId of selected) {
    const source = playersRoot.querySelector(`input[name="player"][value="${CSS.escape(playerId)}"]`);
    const labelText = source?.parentElement?.textContent?.trim() || playerId;
    const label = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'startingPlayer';
    radio.value = playerId;
    radio.required = true;
    radio.checked = selected.length === 1 ? true : explicitStarterId === playerId;
    radio.addEventListener('change', () => { if (radio.checked) explicitStarterId = playerId; });
    label.append(radio, document.createTextNode(labelText));
    root.append(label);
  }
}

if (form && playersRoot) {
  makeStarterUi();
  playersRoot.addEventListener('change', rebuildStarterOptions);
  new MutationObserver(rebuildStarterOptions).observe(playersRoot, { childList: true });
  form.addEventListener('reset', () => { pendingStartingPlayerId = null; explicitStarterId = null; queueMicrotask(rebuildStarterOptions); });
  form.addEventListener('submit', () => {
    pendingStartingPlayerId = form.querySelector('input[name="startingPlayer"]:checked')?.value || null;
  }, true);
  rebuildStarterOptions();
}

const nativeFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async function trivialFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
  const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (url.pathname !== '/api/matches' || method !== 'POST' || !init.body) return nativeFetch(input, init);

  let payload;
  try { payload = JSON.parse(init.body); } catch { return nativeFetch(input, init); }
  const starterId = pendingStartingPlayerId || payload.startingPlayerId || null;
  if (!starterId || !Array.isArray(payload.playerIds) || !payload.playerIds.includes(starterId)) return nativeFetch(input, init);

  const createInit = { ...init, body: JSON.stringify({ ...payload, startingPlayerId: starterId }) };
  try {
    const createdResponse = await nativeFetch(input, createInit);
    if (!createdResponse.ok) return createdResponse;
    const created = await createdResponse.clone().json().catch(() => null);
    const matchId = created?.match?.matchId;
    if (!matchId || created?.state?.currentTurnPlayerId === starterId) return createdResponse;

    const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const selectedResponse = await nativeFetch(`/api/matches/${encodeURIComponent(matchId)}/actions`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId },
      body: JSON.stringify({ action: 'select_turn', playerId: starterId, requestId }),
    });
    if (!selectedResponse.ok) return createdResponse;
    const updated = await selectedResponse.text();
    return new Response(updated, {
      status: createdResponse.status,
      statusText: createdResponse.statusText,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  } finally {
    pendingStartingPlayerId = null;
  }
};
