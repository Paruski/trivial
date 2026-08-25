import { loadSeed } from './seed.js';
import { loadRuntime, saveRuntime, replaceRuntime, downloadRuntime } from './pages-db.js';
import { TYPES, activeEvents, deriveState, selectQuestion, appendEvent, undo, redo, canUndo, canRedo, stats, globalUsedQuestionKeys, weightsForMatch } from './pages-engine.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const el = {
  tabs: $$('.tab'), views: $$('.view'), status: $('#status'), game: $('#game-root'), picker: $('#match-picker'), newMatch: $('#new-match'),
  dialog: $('#new-dialog'), form: $('#new-form'), bank: $('#new-bank'), players: $('#new-players'), starting: $('#new-starting-player'), categories: $('#new-categories'), levels: $('#new-levels'), weight: $('#weight-note'),
  discardDialog: $('#discard-dialog'), discardForm: $('#discard-form'), stats: $('#stats-root'), base: $('#base-root'), exportLocal: $('#export-local'), importLocal: $('#import-local'), toast: $('#toast')
};

let seed;
let runtime;
let currentMatchId = null;
let selectedCategoryId = null;
let selectedQuesito = false;
let toastTimer;
const channel = 'BroadcastChannel' in globalThis ? new BroadcastChannel('trivial-pages-static') : null;

function node(tag, attrs = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key === 'checked') element.checked = Boolean(value);
    else if (key === 'disabled') element.disabled = Boolean(value);
    else if (key === 'style') element.style.cssText = value;
    else if (key.startsWith('on')) element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value != null && value !== false) element.setAttribute(key, String(value));
  }
  for (const child of (Array.isArray(children) ? children : [children])) if (child != null) element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return element;
}

function toast(message) {
  clearTimeout(toastTimer);
  el.toast.textContent = message;
  el.toast.classList.add('show');
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 3500);
}

function playerName(playerId, match = null) { return match?.snapshot?.players?.find(x => x.playerId === playerId)?.name ?? seed.players.find(x => x.playerId === playerId)?.name ?? playerId; }
function categoryInfo(match, categoryId) { return match?.snapshot?.categories?.find(x => x.categoryId === categoryId) ?? seed.categories.find(x => x.bankId === match?.bankId && x.categoryId === categoryId) ?? { categoryId, label: categoryId, emoji: '', color: '#888' }; }
function levelInfo(match, levelKey) { return match?.snapshot?.levels?.find(x => x.levelKey === levelKey) ?? seed.levels.find(x => x.levelKey === levelKey) ?? { levelKey, label: levelKey }; }
function pct(value) { return `${Math.round((Number(value) || 0) * 1000) / 10}%`; }
function eventsFor(matchId) { return runtime.events.filter(event => event.matchId === matchId); }
function matchById(matchId) { return runtime.matches.find(match => match.matchId === matchId); }

async function persist() {
  await saveRuntime(runtime);
  channel?.postMessage({ type: 'changed', at: runtime.updatedAt });
  try { localStorage.setItem('trivial-pages-ping', String(Date.now())); } catch {}
}

function currentMatch() { return matchById(currentMatchId); }
function currentState() { const match = currentMatch(); return match ? deriveState(match, eventsFor(match.matchId)) : null; }

function availableQuestions(match, categoryId = null, levelKey = null) {
  const used = globalUsedQuestionKeys(seed, runtime);
  return seed.questions.filter(q => q.bankId === match.bankId && q.status === 'active' && (!categoryId || q.categoryId === categoryId) && (!levelKey || q.levelKey === levelKey) && match.categoryIds.includes(q.categoryId) && match.levelKeys.includes(q.levelKey) && !used.has(q.questionKey));
}

function renderPicker() {
  el.picker.replaceChildren();
  if (!runtime.matches.length) {
    el.picker.append(node('option', { text: 'Sin partidas locales' }));
    el.picker.disabled = true;
    currentMatchId = null;
    return;
  }
  el.picker.disabled = false;
  if (!currentMatchId || !matchById(currentMatchId)) currentMatchId = runtime.matches.at(-1).matchId;
  for (const match of [...runtime.matches].reverse()) {
    const state = deriveState(match, eventsFor(match.matchId));
    const names = match.playerIds.map(id => playerName(id, match)).join('+');
    const option = node('option', { value: match.matchId, text: `${match.name} · ${names} · ${state.status === 'closed' ? 'cerrada' : 'abierta'}` });
    option.selected = match.matchId === currentMatchId;
    el.picker.append(option);
  }
}

function renderGame() {
  renderPicker();
  el.game.className = '';
  el.game.replaceChildren();
  const match = currentMatch();
  if (!match) {
    el.game.append(node('div', { class: 'empty card', text: 'Crea una partida para empezar.' }));
    return;
  }
  const events = eventsFor(match.matchId);
  const state = deriveState(match, events);
  const layout = node('div', { class: 'grid two' });
  const main = node('section', { class: 'card game-main' });
  const side = node('aside', { class: 'card marker' });
  main.append(node('p', { class: 'eyebrow', text: state.status === 'closed' ? 'PARTIDA CERRADA' : state.currentDraw ? 'PREGUNTA PENDIENTE' : 'TURNO' }), node('h2', { text: state.status === 'closed' ? 'Partida finalizada' : state.currentDraw ? 'Pregunta en juego' : `Juega ${playerName(state.currentPlayerId, match)}` }));
  if (state.status === 'closed') renderClosed(main, match, state);
  else if (state.currentDraw) renderQuestion(main, match, state);
  else renderTurn(main, match, state);
  renderMarker(side, match, state, events);
  layout.append(main, side);
  el.game.append(layout);
}

function renderClosed(root, match, state) {
  const winners = state.close?.winners ?? [];
  const reason = state.close?.reason === 'victoria' ? 'Victoria' : 'Cierre manual';
  root.append(node('p', { class: 'notice', text: `${reason}${winners.length ? ` · ${winners.map(id => playerName(id, match)).join(' y ')}` : ''}.` }));
}

function renderTurn(root, match, state) {
  root.append(node('div', { class: 'turn-banner' }, [node('strong', { text: `Turno · ${playerName(state.currentPlayerId, match)}` }), node('span', { class: 'muted', text: `Inicio: ${playerName(match.startingPlayerId, match)} · rotación ${match.playerIds.map(id => playerName(id, match)).join(' → ')}` })]));
  root.append(node('p', { text: '1. Elige la categoría indicada por el tablero' }));
  const grid = node('div', { class: 'category-grid' });
  for (const categoryId of match.categoryIds) {
    const category = categoryInfo(match, categoryId);
    const stock = availableQuestions(match, categoryId).length;
    grid.append(node('button', { type: 'button', class: `category-button${selectedCategoryId === categoryId ? ' active' : ''}${stock ? '' : ' stock-zero'}`, disabled: !stock, onclick: () => { selectedCategoryId = categoryId; selectedQuesito = false; renderGame(); } }, [node('span', { class: 'category-dot', style: `--category-color:${category.color}` }), `${category.emoji} ${category.label} · ${stock}`]));
  }
  root.append(grid);
  const owned = state.quesitosByPlayer.get(state.currentPlayerId)?.has(selectedCategoryId);
  const toggle = node('label', { class: 'quesito-toggle' });
  toggle.append(node('input', { id: 'quesito-toggle', type: 'checkbox', checked: selectedQuesito, disabled: !selectedCategoryId || owned, onchange: event => { selectedQuesito = event.target.checked; } }), owned ? '2. Quesito ya obtenido' : '2. Este turno es un intento de quesito');
  root.append(toggle, node('button', { id: 'draw-question', class: 'primary', type: 'button', text: 'Sacar pregunta', disabled: !selectedCategoryId, onclick: drawQuestion }));
}

async function drawQuestion() {
  const match = currentMatch();
  const state = currentState();
  if (!match || !state || !selectedCategoryId) return;
  const selected = selectQuestion(seed, runtime, match, selectedCategoryId);
  if (!selected) return toast('No queda ninguna pregunta disponible en esa categoría y niveles.');
  const q = selected.question;
  appendEvent(runtime, match.matchId, TYPES.QUESTION_DRAWN, { drawOrdinal: selected.ordinal, randomUnit: selected.unit, effectiveWeights: selected.effectiveWeights, playerId: state.currentPlayerId, categoryId: selectedCategoryId, levelKey: selected.levelKey, questionKey: q.questionKey, quesitoAttempt: selectedQuesito, selectionReason: selected.reason, prompt: q.prompt, answer: q.answer, explanation: q.explanation });
  selectedQuesito = false;
  await persist();
  renderAll();
}

function renderQuestion(root, match, state) {
  const draw = state.currentDraw;
  const category = categoryInfo(match, draw.categoryId);
  const level = levelInfo(match, draw.levelKey);
  root.append(node('div', { class: 'badges' }, [node('span', { class: 'badge' }, [node('span', { class: 'category-dot', style: `--category-color:${category.color}` }), `${category.emoji} ${category.label}`]), node('span', { class: 'badge', text: `Nivel: ${level.label}` }), node('span', { class: 'badge', text: `Turno: ${playerName(draw.playerId, match)}` }), draw.quesitoAttempt ? node('span', { class: 'badge', text: 'Intento de quesito' }) : null]));
  const card = node('div', { class: 'question-card' }, [node('div', { class: 'question-text', text: draw.prompt })]);
  if (state.answerRevealed) card.append(node('div', { class: 'answer-box', id: 'answer' }, [node('strong', { text: `Respuesta: ${draw.answer}` }), node('p', { text: draw.explanation })]));
  root.append(card);
  const actions = node('div', { class: 'actions wrap' });
  if (!state.answerRevealed) actions.append(node('button', { class: 'primary', text: 'Mostrar respuesta', onclick: revealAnswer }));
  actions.append(node('button', { class: 'danger', text: 'Descartar pregunta', onclick: () => el.discardDialog.showModal() }));
  root.append(actions);
  if (state.answerRevealed) root.append(node('div', { class: 'actions' }, [node('button', { class: 'good', text: 'Acierto', onclick: () => recordResult(true) }), node('button', { class: 'danger', text: 'Fallo', onclick: () => recordResult(false) })]));
}

async function revealAnswer() {
  const match = currentMatch(); const state = currentState(); if (!state?.currentDraw) return;
  appendEvent(runtime, match.matchId, TYPES.ANSWER_REVEALED, { drawEventId: state.currentDraw.eventId, questionKey: state.currentDraw.questionKey });
  await persist(); renderAll();
}

async function recordResult(correct) {
  const match = currentMatch(); const state = currentState(); const draw = state?.currentDraw; if (!draw || !state.answerRevealed) return;
  const actionId = crypto.randomUUID();
  const owned = state.quesitosByPlayer.get(draw.playerId) ?? new Set();
  const quesitoWon = Boolean(correct && draw.quesitoAttempt && !owned.has(draw.categoryId));
  appendEvent(runtime, match.matchId, TYPES.RESULT_RECORDED, { drawEventId: draw.eventId, questionKey: draw.questionKey, playerId: draw.playerId, categoryId: draw.categoryId, levelKey: draw.levelKey, correct, quesitoAttempt: draw.quesitoAttempt, quesitoWon }, actionId);
  const won = new Set(owned); if (quesitoWon) won.add(draw.categoryId);
  if (match.categoryIds.every(id => won.has(id))) appendEvent(runtime, match.matchId, TYPES.MATCH_CLOSED, { reason: 'victoria', winners: [draw.playerId] }, actionId);
  selectedCategoryId = null; selectedQuesito = false;
  await persist(); renderAll();
}

async function discardQuestion(event) {
  event.preventDefault();
  const match = currentMatch(); const state = currentState(); const draw = state?.currentDraw; if (!draw) return;
  const form = new FormData(el.discardForm); const actionId = crypto.randomUUID();
  appendEvent(runtime, match.matchId, TYPES.QUESTION_EXPOSED, { drawEventId: draw.eventId, questionKey: draw.questionKey, playerId: draw.playerId, categoryId: draw.categoryId, levelKey: draw.levelKey, reason: String(form.get('reason')), note: String(form.get('note') || ''), quesitoAttempt: draw.quesitoAttempt }, actionId);
  const selected = selectQuestion(seed, runtime, match, draw.categoryId, draw.levelKey);
  if (selected) {
    const q = selected.question;
    appendEvent(runtime, match.matchId, TYPES.QUESTION_DRAWN, { drawOrdinal: selected.ordinal, randomUnit: selected.unit, effectiveWeights: selected.effectiveWeights, playerId: draw.playerId, categoryId: draw.categoryId, levelKey: selected.levelKey, questionKey: q.questionKey, quesitoAttempt: draw.quesitoAttempt, replacementForEventId: draw.eventId, selectionReason: selected.reason, prompt: q.prompt, answer: q.answer, explanation: q.explanation }, actionId);
  }
  el.discardDialog.close(); el.discardForm.reset(); await persist(); renderAll();
  if (!selected) toast('Pregunta retirada. No queda sustituta disponible en esa categoría.');
}

function renderMarker(root, match, state, events) {
  root.append(node('p', { class: 'eyebrow', text: 'MARCADOR' }), node('h3', { text: match.name }), node('div', { class: 'turn-banner' }, [node('strong', { text: playerName(state.currentPlayerId, match) }), node('span', { text: state.status === 'closed' ? 'partida cerrada' : 'turno actual' })]));
  const results = activeEvents(events).filter(e => e.type === TYPES.RESULT_RECORDED).map(e => e.payload);
  for (const playerId of match.playerIds) {
    const playerResults = results.filter(r => r.playerId === playerId);
    const dots = node('div', { class: 'quesitos' });
    for (const categoryId of match.categoryIds) {
      const category = categoryInfo(match, categoryId); const owned = state.quesitosByPlayer.get(playerId)?.has(categoryId);
      dots.append(node('span', { class: `quesito${owned ? ' owned' : ''}`, style: `--category-color:${category.color}`, title: category.label, text: owned ? '✓' : '·' }));
    }
    root.append(node('div', { class: 'marker-row' }, [node('div', { class: 'marker-head' }, [node('strong', { text: playerName(playerId, match) }), node('span', { text: `${playerResults.filter(r => r.correct).length}✓ ${playerResults.filter(r => !r.correct).length}✕` })]), dots]));
  }
  root.append(node('hr'), node('div', { class: 'actions wrap' }, [node('button', { text: 'Deshacer', disabled: !canUndo(events) || Boolean(state.currentDraw && !state.currentDraw.replacementForEventId), onclick: async () => { if (undo(runtime, match.matchId)) { await persist(); renderAll(); } } }), node('button', { text: 'Rehacer', disabled: !canRedo(events), onclick: async () => { if (redo(runtime, match.matchId)) { await persist(); renderAll(); } } })]));
  if (state.status === 'open') root.append(node('button', { class: 'danger', text: 'Cerrar partida', disabled: Boolean(state.currentDraw), onclick: async () => { appendEvent(runtime, match.matchId, TYPES.MATCH_CLOSED, { reason: 'manual', winners: [] }); await persist(); renderAll(); } }));
  root.append(node('p', { class: 'muted mono', text: `semilla ${match.seed.slice(0, 12)}…\npesos congelados al crear` }));
}

function updateStartingChoices() {
  const selected = $$('input[name="player"]:checked', el.form).map(input => input.value);
  const previous = $('input[name="startingPlayer"]:checked', el.form)?.value;
  el.starting.replaceChildren();
  for (const playerId of selected) {
    const player = seed.players.find(p => p.playerId === playerId);
    el.starting.append(node('label', {}, [node('input', { type: 'radio', name: 'startingPlayer', value: playerId, checked: selected.length === 1 || previous === playerId }), player?.name ?? playerId]));
  }
}

function buildDialog(bankId) {
  el.players.replaceChildren(); el.categories.replaceChildren(); el.levels.replaceChildren();
  for (const player of seed.players.filter(p => p.active)) el.players.append(node('label', {}, [node('input', { type: 'checkbox', name: 'player', value: player.playerId, onchange: updateStartingChoices }), player.name]));
  updateStartingChoices();
  for (const category of seed.categories.filter(c => c.bankId === bankId && c.active)) {
    const stock = seed.questions.filter(q => q.bankId === bankId && q.categoryId === category.categoryId && q.status === 'active').length;
    el.categories.append(node('label', {}, [node('input', { type: 'checkbox', name: 'category', value: category.categoryId, checked: stock > 0, disabled: !stock }), `${category.emoji} ${category.label}`]));
  }
  for (const level of seed.levels) {
    const stock = seed.questions.some(q => q.bankId === bankId && q.levelKey === level.levelKey && q.status === 'active');
    if (stock) el.levels.append(node('label', {}, [node('input', { type: 'checkbox', name: 'level', value: level.levelKey, checked: true, onchange: updateWeightNote }), level.label]));
  }
  updateWeightNote();
}

function updateWeightNote() {
  const levels = $$('input[name="level"]:checked', el.form).map(input => input.value);
  const labels = levels.map(key => seed.levels.find(l => l.levelKey === key)?.label ?? key);
  el.weight.textContent = levels.length ? `Niveles incluidos: ${labels.join(' · ')}. Las probabilidades se congelan por categoría según la composición original del banco; el stock restante no reduce el peso de un nivel mientras conserve preguntas.` : 'Selecciona al menos un nivel.';
}

function openNewDialog() {
  el.bank.replaceChildren(...seed.banks.map(bank => node('option', { value: bank.bankId, text: bank.name })));
  buildDialog(el.bank.value);
  el.dialog.showModal();
}

async function createMatch(event) {
  event.preventDefault();
  const form = new FormData(el.form);
  const playerIds = $$('input[name="player"]:checked', el.form).map(input => input.value);
  const categoryIds = $$('input[name="category"]:checked', el.form).map(input => input.value);
  const levelKeys = $$('input[name="level"]:checked', el.form).map(input => input.value);
  const startingPlayerId = String(form.get('startingPlayer') || '');
  if (playerIds.length < 1 || playerIds.length > 3) return toast('Selecciona entre uno y tres jugadores.');
  if (!playerIds.includes(startingPlayerId)) return toast('Elige qué jugador empieza.');
  if (!categoryIds.length) return toast('Selecciona al menos una categoría.');
  if (!levelKeys.length) return toast('Selecciona al menos un nivel.');
  const bankId = el.bank.value;
  const temp = { matchId: 'temp', bankId, playerIds, categoryIds, levelKeys, startingPlayerId, seed: 'temp', levelWeights: {} };
  for (const categoryId of categoryIds) if (!seed.questions.some(q => q.bankId === bankId && q.categoryId === categoryId && levelKeys.includes(q.levelKey) && q.status === 'active' && !globalUsedQuestionKeys(seed, runtime).has(q.questionKey))) return toast(`No queda stock compatible en ${categoryInfo(temp, categoryId).label}.`);
  const now = new Date();
  const matchId = `M${now.toISOString().slice(0,10).replaceAll('-','')}-${crypto.randomUUID().slice(0,8)}`;
  const match = {
    matchId, name: String(form.get('name') || '').trim() || `Partida ${now.toLocaleDateString('es-ES')}`, bankId, playerIds, categoryIds, levelKeys, startingPlayerId,
    seed: crypto.randomUUID().replaceAll('-', ''), levelWeights: weightsForMatch(seed, bankId, categoryIds, levelKeys), createdAt: now.toISOString(),
    snapshot: {
      players: playerIds.map(playerId => ({ playerId, name: seed.players.find(p => p.playerId === playerId)?.name ?? playerId })),
      categories: categoryIds.map(categoryId => { const c = seed.categories.find(x => x.bankId === bankId && x.categoryId === categoryId); return { categoryId, label: c.label, color: c.color, emoji: c.emoji }; }),
      levels: levelKeys.map(levelKey => { const l = seed.levels.find(x => x.levelKey === levelKey); return { levelKey, label: l.label }; })
    }
  };
  runtime.matches.push(match);
  appendEvent(runtime, matchId, TYPES.MATCH_CREATED, { matchId, bankId, playerIds, categoryIds, levelKeys, startingPlayerId, seed: match.seed, levelWeights: match.levelWeights });
  currentMatchId = matchId; selectedCategoryId = null; selectedQuesito = false;
  await persist(); el.dialog.close(); el.form.reset(); renderAll();
}

function renderStats() {
  const result = stats(seed, runtime); el.stats.replaceChildren();
  const cards = node('div', { class: 'metric-grid' });
  for (const row of result.byPlayer.sort((a,b) => a.key.localeCompare(b.key))) cards.append(node('article', { class: 'metric-card' }, [node('strong', { text: playerName(row.key) }), node('div', { class: 'kpi', text: pct(row.accuracy) }), node('p', { class: 'muted', text: `${row.correct}/${row.attempts} aciertos · quesitos ${row.quesitosWon}/${row.quesitoAttempts}` })]));
  el.stats.append(node('section', { class: 'card stack' }, [node('p', { class: 'eyebrow', text: 'GLOBAL' }), node('h3', { text: 'Histórico canónico + partidas locales' }), cards]));
  const table = node('div', { class: 'grid two' });
  const panel = (title, rows, label) => node('article', { class: 'card stack' }, [node('h3', { text: title }), ...rows.map(row => node('div', { class: 'metric-row' }, [node('span', { text: label(row) }), node('strong', { text: `${row.correct}/${row.attempts} · ${pct(row.accuracy)}` })]))]);
  table.append(panel('Jugador × categoría', result.byPlayerCategory, row => { const [p,c] = row.key.split('|'); const cat = seed.categories.find(x => x.categoryId === c); return `${playerName(p)} · ${cat?.label ?? c}`; }), panel('Jugador × nivel', result.byPlayerLevel, row => { const split = row.key.split('|'); const p = split.shift(); const key = split.join('|'); return `${playerName(p)} · ${seed.levels.find(x => x.levelKey === key)?.label ?? key}`; }));
  el.stats.append(table);
}

function renderBase() {
  const used = globalUsedQuestionKeys(seed, runtime); const active = seed.questions.filter(q => q.status === 'active' && !used.has(q.questionKey));
  el.base.replaceChildren(node('div', { class: 'grid three' }, [node('article', { class: 'card' }, [node('div', { class: 'kpi', text: String(seed.questions.length) }), node('p', { text: 'preguntas en el repositorio' })]), node('article', { class: 'card' }, [node('div', { class: 'kpi', text: String(active.length) }), node('p', { text: 'disponibles ahora' })]), node('article', { class: 'card' }, [node('div', { class: 'kpi', text: String(used.size) }), node('p', { text: 'retiradas, administradas o expuestas' })])]));
  const cards = node('div', { class: 'stock-cards' });
  for (const category of seed.categories.filter(c => c.active)) for (const level of seed.levels) {
    const count = active.filter(q => q.bankId === category.bankId && q.categoryId === category.categoryId && q.levelKey === level.levelKey).length;
    cards.append(node('article', { class: `stock-card${count === 0 ? ' zero' : count <= 5 ? ' low' : ''}` }, [node('strong', { text: `${category.emoji} ${category.label} · ${level.label}` }), node('div', { class: 'kpi', text: String(count) })]));
  }
  el.base.append(node('section', { class: 'stack' }, [node('h3', { text: 'Stock disponible' }), cards]));
}

function renderAll() { renderGame(); renderStats(); renderBase(); }

el.tabs.forEach(tab => tab.onclick = () => { el.tabs.forEach(x => x.classList.toggle('active', x === tab)); el.views.forEach(view => view.classList.toggle('active', view.id === `view-${tab.dataset.view}`)); });
el.newMatch.onclick = openNewDialog;
el.bank.onchange = () => buildDialog(el.bank.value);
el.form.onsubmit = createMatch;
el.discardForm.onsubmit = discardQuestion;
$$('[data-close]').forEach(button => button.onclick = () => document.getElementById(button.dataset.close).close());
el.picker.onchange = () => { currentMatchId = el.picker.value; selectedCategoryId = null; selectedQuesito = false; renderGame(); };
el.exportLocal.onclick = () => downloadRuntime(runtime);
el.importLocal.onchange = async () => { try { const file = el.importLocal.files[0]; if (!file) return; runtime = await replaceRuntime(JSON.parse(await file.text())); currentMatchId = runtime.matches.at(-1)?.matchId ?? null; renderAll(); toast('Copia local restaurada.'); } catch (error) { toast(error.message); } finally { el.importLocal.value = ''; } };
channel?.addEventListener('message', async () => { runtime = await loadRuntime(); renderAll(); });
window.addEventListener('storage', async event => { if (event.key === 'trivial-pages-ping') { runtime = await loadRuntime(); renderAll(); } });

try {
  [seed, runtime] = await Promise.all([loadSeed(), loadRuntime()]);
  currentMatchId = runtime.matches.at(-1)?.matchId ?? null;
  renderAll();
  el.status.lastChild.textContent = 'Local · listo';
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(console.warn);
} catch (error) {
  console.error(error); el.status.className = 'connection offline'; el.status.lastChild.textContent = 'Error de datos'; el.game.className = 'warning'; el.game.textContent = `No se pudo iniciar: ${error.message}`;
}
