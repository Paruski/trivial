import { adminGet, get, post } from './api.js';

const $ = selector => document.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const elements = {
  tabs: $$('.tab'), views: $$('.view'), connection: $('#connection-status'), game: $('#game-root'), picker: $('#match-picker'), newMatch: $('#new-match-btn'), newDialog: $('#new-match-dialog'), newForm: $('#new-match-form'), bank: $('#new-match-bank'), players: $('#new-match-players'), categories: $('#new-match-categories'), levels: $('#new-match-levels'), weights: $('#effective-weights'), discardDialog: $('#discard-dialog'), discardForm: $('#discard-form'), stats: $('#stats-root'), base: $('#base-root'), diagnostics: $('#diagnostics-root'), adminToken: $('#admin-token'), importBackup: $('#import-backup'), toast: $('#toast'), updateBanner: $('#update-banner'),
};

let model = null;
let detail = null;
let currentMatchId = null;
let currentView = 'game';
let selectedCategoryId = null;
let selectedQuesito = false;
let selectedRespondentId = null;
let busy = false;
let lastRevision = 0;
let toastTimer;
let waitingWorker = null;
let reportedSeedError = null;

function node(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key.startsWith('on')) element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'checked') element.checked = Boolean(value);
    else if (key === 'disabled') element.disabled = Boolean(value);
    else if (key === 'style') element.style.cssText = value;
    else if (value !== false && value != null) element.setAttribute(key, String(value));
  }
  for (const child of (Array.isArray(children) ? children : [children])) if (child != null) element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return element;
}

function toast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  toastTimer = setTimeout(() => elements.toast.classList.remove('show'), 4200);
}

function setConnection(online, label = online ? 'Servidor conectado' : 'Sin conexión') {
  elements.connection.className = `connection ${online ? 'online' : 'offline'}`;
  elements.connection.lastChild.textContent = label;
}

function setOperationalStatus() {
  const error = model?.seed?.error;
  setConnection(!error, error ? 'Error en CSV' : 'Servidor conectado');
  if (error && error !== reportedSeedError) toast(`Semilla rechazada; se mantiene la última versión válida. ${error}`);
  reportedSeedError = error;
}

async function runAction(task) {
  if (busy) return;
  busy = true;
  document.body.classList.add('busy');
  try {
    await task();
    setOperationalStatus();
  } catch (error) {
    console.error(error);
    if (error.status) setOperationalStatus();
    else setConnection(false, 'Servidor no disponible');
    toast(error.message || 'No se pudo completar la operación.');
  } finally {
    busy = false;
    document.body.classList.remove('busy');
  }
}

const categoryFrom = (bankId, categoryId) => model?.categories.find(category => category.bankId === bankId && category.categoryId === categoryId);
const levelFrom = levelKey => model?.levels.find(level => level.levelKey === levelKey);
const playerName = playerId => model?.players.find(player => player.playerId === playerId)?.name ?? detail?.match.catalogSnapshot.players.find(player => player.playerId === playerId)?.name ?? playerId;
const pct = value => `${Math.round((Number(value) || 0) * 1000) / 10}%`;
const ci = interval => `IC 95% ${pct(interval?.low)}–${pct(interval?.high)}`;

async function loadBootstrap() {
  model = await get('/api/bootstrap');
  lastRevision = model.revision;
  if (!currentMatchId || !model.matches.some(match => match.matchId === currentMatchId)) currentMatchId = model.matches.find(match => match.writable && match.status === 'open')?.matchId ?? model.matches[0]?.matchId ?? null;
  renderPicker();
  renderBase();
  elements.newMatch.disabled = false;
  setOperationalStatus();
}

async function loadDetail() {
  detail = currentMatchId ? await get(`/api/matches/${encodeURIComponent(currentMatchId)}`) : null;
  renderGame();
}

async function refreshGame() {
  await loadBootstrap();
  await loadDetail();
}

function renderPicker() {
  elements.picker.replaceChildren();
  if (!model.matches.length) {
    elements.picker.append(node('option', { text: 'Sin partidas' }));
    elements.picker.disabled = true;
    return;
  }
  elements.picker.disabled = false;
  for (const match of model.matches) {
    const names = match.players.map(player => player.name).join('+');
    const option = node('option', { value: match.matchId, text: `${match.name} · ${names} · ${match.status === 'closed' ? 'cerrada' : 'abierta'}${match.writable ? '' : ' · lectura'}` });
    option.selected = match.matchId === currentMatchId;
    elements.picker.append(option);
  }
}

function renderGame() {
  elements.game.className = '';
  elements.game.replaceChildren();
  if (!detail) {
    elements.game.append(node('div', { class: 'empty card', text: 'Crea una partida para empezar.' }));
    return;
  }
  const layout = node('div', { class: 'grid two' });
  const main = node('section', { class: 'card game-main' });
  const side = node('aside', { class: 'card marker' });
  const state = detail.state;
  main.append(node('p', { class: 'eyebrow', text: state.status === 'closed' ? 'PARTIDA CERRADA' : state.currentDraw ? 'PREGUNTA PENDIENTE' : state.currentTurnPlayerId ? 'TURNO PREPARADO' : 'NUEVO TURNO' }), node('h2', { text: state.status === 'closed' ? 'Partida finalizada' : state.currentDraw ? 'Pregunta en juego' : state.currentTurnPlayerId ? 'Elige la categoría' : '¿Quién juega?' }));
  if (!detail.writable && detail.match.source === 'web') main.append(node('p', { class: 'warning', text: 'Esta partida pertenece a otra sesión y se muestra en modo lectura.' }));
  if (state.status === 'closed') renderClosed(main);
  else if (!detail.writable) main.append(node('p', { class: 'notice', text: 'La partida no puede modificarse desde esta sesión.' }));
  else if (state.currentDraw) renderQuestion(main);
  else renderTurn(main);
  renderMarker(side);
  layout.append(main, side);
  elements.game.append(layout);
}

function renderClosed(root) {
  const reasonLabels = { victoria: 'victoria', manual: 'cierre manual', time_limit: 'tiempo límite', interruption: 'interrupción', other: 'otro motivo' };
  const close = detail.state.close;
  const winners = close?.winners ?? [];
  root.append(node('p', { class: 'notice', text: `Motivo: ${reasonLabels[close?.reason] ?? detail.match.closeReason ?? 'cierre histórico'}.${winners.length ? ` Mejor puntuación: ${winners.map(playerName).join(' y ')}${winners.length > 1 ? ' (empate)' : ''}.` : ''}` }));
}

function playerButtons(selected, onselect) {
  const wrap = node('div', { class: 'turn-select' });
  for (const player of detail.match.catalogSnapshot.players) wrap.append(node('button', { type: 'button', class: `player-button${selected === player.playerId ? ' active' : ''}`, text: player.name, 'data-player-id': player.playerId, onclick: () => onselect(player.playerId) }));
  return wrap;
}

function renderTurn(root) {
  const state = detail.state;
  root.append(node('p', { text: '1. Elige explícitamente el jugador del turno' }), playerButtons(state.currentTurnPlayerId, playerId => gameAction({ action: 'select_turn', playerId }, () => { selectedCategoryId = null; selectedQuesito = false; })));
  if (!state.currentTurnPlayerId) return;
  root.append(node('div', { class: 'turn-banner' }, [node('strong', { text: `Turno · ${playerName(state.currentTurnPlayerId)}` }), node('span', { class: 'muted', text: 'No existe rotación automática' })]), node('p', { text: '2. Elige la categoría' }));
  const categories = detail.match.catalogSnapshot.categories;
  const grid = node('div', { class: 'category-grid', 'data-testid': 'category-picker' });
  for (const category of categories) {
    const stock = detail.stock.filter(row => row.categoryId === category.categoryId).reduce((sum, row) => sum + row.count, 0);
    grid.append(node('button', { type: 'button', class: `category-button${selectedCategoryId === category.categoryId ? ' active' : ''}${stock ? '' : ' stock-zero'}`, disabled: !stock, 'data-category-id': category.categoryId, onclick: () => { selectedCategoryId = category.categoryId; selectedQuesito = false; renderGame(); } }, [node('span', { class: 'category-dot', style: `--category-color:${category.color}` }), `${category.emoji} ${category.label} · ${stock}`]));
  }
  root.append(grid);
  const owned = detail.marker.find(row => row.playerId === state.currentTurnPlayerId)?.quesitos.includes(selectedCategoryId);
  const toggle = node('label', { class: 'quesito-toggle' });
  toggle.append(node('input', { id: 'quesito-toggle', type: 'checkbox', checked: selectedQuesito, disabled: !selectedCategoryId || owned, onchange: event => { selectedQuesito = event.target.checked; } }), owned ? '3. Quesito ya obtenido' : '3. Este turno es un intento de quesito');
  root.append(toggle, node('button', { id: 'draw-question', class: 'primary', type: 'button', text: 'Sacar pregunta', disabled: !selectedCategoryId, onclick: () => gameAction({ action: 'draw', categoryId: selectedCategoryId, quesitoAttempt: selectedQuesito }) }));
}

function renderQuestion(root) {
  const draw = detail.state.currentDraw;
  const category = detail.match.catalogSnapshot.categories.find(item => item.categoryId === draw.categoryId);
  const level = detail.match.catalogSnapshot.levels.find(item => item.levelKey === draw.levelKey);
  root.append(node('div', { class: 'badges' }, [node('span', { class: 'badge' }, [node('span', { class: 'category-dot', style: `--category-color:${category?.color}` }), `${category?.emoji ?? ''} ${category?.label ?? draw.categoryId}`]), node('span', { class: 'badge', text: `Nivel: ${level?.label ?? draw.levelKey}` }), node('span', { class: 'badge', text: `Turno: ${playerName(draw.playerId)}` }), draw.quesitoAttempt ? node('span', { class: 'badge', text: 'Intento de quesito' }) : null]));
  const question = node('div', { class: 'question-card' }, [node('div', { class: 'question-text', text: draw.prompt })]);
  if (detail.state.answerRevealed) question.append(node('div', { class: 'answer-box', id: 'answer', 'data-testid': 'answer' }, [node('strong', { text: `Respuesta: ${draw.answer}` }), node('p', { text: draw.explanation })]));
  root.append(question);
  const controls = node('div', { class: 'actions wrap' });
  if (!detail.state.answerRevealed) controls.append(node('button', { id: 'reveal-answer', class: 'primary', text: 'Mostrar respuesta', onclick: () => gameAction({ action: 'reveal' }) }));
  controls.append(node('button', { id: 'discard-question', class: 'danger', text: 'Descartar pregunta', onclick: () => elements.discardDialog.showModal() }));
  root.append(controls);
  if (!detail.state.answerRevealed) return;
  if (!detail.match.playerIds.includes(selectedRespondentId)) selectedRespondentId = draw.playerId;
  root.append(node('div', { class: 'respondent' }, [node('strong', { text: '¿Quién ha respondido?' }), playerButtons(selectedRespondentId, playerId => { selectedRespondentId = playerId; renderGame(); })]), node('div', { class: 'actions' }, [node('button', { id: 'record-correct', class: 'good', text: 'Acierto', onclick: () => recordResult(true) }), node('button', { id: 'record-wrong', class: 'danger', text: 'Fallo', onclick: () => recordResult(false) })]));
}

function renderMarker(root) {
  root.append(node('p', { class: 'eyebrow', text: 'MARCADOR' }), node('h3', { text: detail.match.name }));
  if (detail.state.currentTurnPlayerId) root.append(node('div', { class: 'turn-banner' }, [node('strong', { text: playerName(detail.state.currentTurnPlayerId) }), node('span', { text: 'turno actual' })]));
  for (const player of detail.marker) {
    const dots = node('div', { class: 'quesitos' });
    for (const category of detail.match.catalogSnapshot.categories) dots.append(node('span', { class: `quesito${player.quesitos.includes(category.categoryId) ? ' owned' : ''}`, style: `--category-color:${category.color}`, title: category.label, text: player.quesitos.includes(category.categoryId) ? '✓' : '·' }));
    root.append(node('div', { class: 'marker-row' }, [node('div', { class: 'marker-head' }, [node('strong', { text: player.name }), node('span', { text: `${player.correct}✓ ${player.wrong}✕` })]), dots]));
  }
  const depleted = detail.stock.filter(row => row.count <= 5);
  if (depleted.length) {
    const stock = node('div', { class: 'stock-list' });
    for (const row of depleted) {
      const category = detail.match.catalogSnapshot.categories.find(item => item.categoryId === row.categoryId);
      const level = detail.match.catalogSnapshot.levels.find(item => item.levelKey === row.levelKey);
      stock.append(node('div', { class: `stock-item ${row.count ? 'low' : 'zero'}` }, [node('span', { text: `${category?.label ?? row.categoryId} · ${level?.label ?? row.levelKey}` }), node('strong', { text: String(row.count) })]));
    }
    root.append(node('hr'), node('strong', { text: 'Stock bajo' }), stock);
  }
  if (!detail.writable) return;
  root.append(node('hr'), node('div', { class: 'actions wrap' }, [node('button', { id: 'undo-action', text: 'Deshacer', disabled: !detail.canUndo, onclick: () => gameAction({ action: 'undo' }) }), node('button', { id: 'redo-action', text: 'Rehacer', disabled: !detail.canRedo, onclick: () => gameAction({ action: 'redo' }) })]));
  if (detail.state.status === 'open') {
    const reason = node('select', { id: 'close-reason', 'aria-label': 'Motivo de cierre' }, [node('option', { value: 'manual', text: 'Cierre manual' }), node('option', { value: 'time_limit', text: 'Tiempo límite' }), node('option', { value: 'interruption', text: 'Interrupción' }), node('option', { value: 'other', text: 'Otro motivo' })]);
    root.append(node('hr'), node('label', {}, ['Finalizar partida', reason]), node('button', { id: 'close-match', class: 'danger', text: 'Cerrar partida', disabled: Boolean(detail.state.currentDraw), onclick: () => gameAction({ action: 'close', reason: reason.value }) }));
  }
  root.append(node('p', { class: 'muted mono', text: `rules ${detail.match.rulesVersion}\nseed ${detail.match.seed.slice(0, 12)}…` }));
}

async function gameAction(payload, before = null) {
  await runAction(async () => {
    before?.();
    detail = await post(`/api/matches/${encodeURIComponent(currentMatchId)}/actions`, payload);
    selectedRespondentId = null;
    if (['result', 'close'].includes(payload.action)) { selectedCategoryId = null; selectedQuesito = false; }
    renderGame();
    await loadBootstrap();
  });
}

function recordResult(correct) {
  gameAction({ action: 'result', playerId: selectedRespondentId, correct });
}

function buildDialog(bankId) {
  elements.players.replaceChildren();
  elements.categories.replaceChildren();
  elements.levels.replaceChildren();
  for (const player of model.players.filter(item => item.active)) elements.players.append(node('label', {}, [node('input', { type: 'checkbox', name: 'player', value: player.playerId }), player.name]));
  for (const category of model.categories.filter(item => item.bankId === bankId && item.active)) {
    const stock = model.base.stock.filter(row => row.bankId === bankId && row.categoryId === category.categoryId).reduce((sum, row) => sum + row.count, 0);
    elements.categories.append(node('label', {}, [node('input', { type: 'checkbox', name: 'category', value: category.categoryId, checked: stock > 0, disabled: stock === 0 }), `${category.emoji} ${category.label}${stock ? '' : ' · agotada'}`]));
  }
  const availableLevels = model.levels.filter(level => model.base.stock.some(row => row.bankId === bankId && row.levelKey === level.levelKey && row.count > 0));
  for (const level of availableLevels) elements.levels.append(node('label', {}, [node('input', { type: 'checkbox', name: 'level', value: level.levelKey, checked: true, onchange: updateWeightNotice }), `${level.label} · ${level.probabilityWeight}`]));
  updateWeightNotice();
}

function updateWeightNotice() {
  const selected = $$('input[name="level"]:checked', elements.newForm).map(input => model.levels.find(level => level.levelKey === input.value)).filter(Boolean);
  const total = selected.reduce((sum, level) => sum + level.probabilityWeight, 0);
  elements.weights.textContent = selected.length ? `Probabilidades efectivas: ${selected.map(level => `${level.label} ${pct(level.probabilityWeight / total)}`).join(' · ')}. Se congelan al crear la partida.` : 'Selecciona al menos un nivel.';
}

function openMatchDialog() {
  elements.bank.replaceChildren(...model.banks.map(bank => node('option', { value: bank.bankId, text: bank.name })));
  buildDialog(elements.bank.value);
  elements.newDialog.showModal();
}

async function createMatch(event) {
  event.preventDefault();
  await runAction(async () => {
    const form = new FormData(elements.newForm);
    const payload = { name: String(form.get('name') || '').trim(), bankId: elements.bank.value, playerIds: $$('input[name="player"]:checked', elements.newForm).map(input => input.value), categoryIds: $$('input[name="category"]:checked', elements.newForm).map(input => input.value), levelKeys: $$('input[name="level"]:checked', elements.newForm).map(input => input.value) };
    detail = await post('/api/matches', payload);
    currentMatchId = detail.match.matchId;
    selectedCategoryId = null; selectedQuesito = false; selectedRespondentId = null;
    elements.newDialog.close(); elements.newForm.reset();
    await loadBootstrap(); renderGame(); setView('game');
  });
}

function metricPanel(title, rows, label) {
  const card = node('article', { class: 'card stack' }, [node('h3', { text: title })]);
  const list = node('div', { class: 'metric-list' });
  if (!rows.length) list.append(node('p', { class: 'muted', text: 'Sin datos computables.' }));
  for (const row of rows) list.append(node('div', { class: 'metric-row' }, [node('div', {}, [node('strong', { text: label(row) }), node('div', { class: 'ci', text: `${row.correct}/${row.attempts} · ${ci(row.accuracyCi)}` })]), node('strong', { text: pct(row.accuracy) }), node('div', { class: 'progress' }, node('span', { style: `width:${row.accuracy * 100}%` }))]));
  card.append(list);
  return card;
}

async function renderStatistics() {
  elements.stats.className = 'loading-card'; elements.stats.textContent = 'Calculando proyecciones e inferencia…';
  const stats = await get('/api/statistics');
  elements.stats.className = 'stack'; elements.stats.replaceChildren();
  if (!stats.byPlayer.length) { elements.stats.append(node('div', { class: 'empty card', text: 'Sin resultados computables.' })); return; }
  const categoryLabel = row => categoryFrom(row.bankId, row.categoryId)?.label ?? row.categoryId;
  const playerCards = node('div', { class: 'metric-grid' });
  for (const row of stats.byPlayer) playerCards.append(node('article', { class: 'metric-card' }, [node('strong', { text: playerName(row.playerId) }), node('div', { class: 'kpi', text: pct(row.accuracy) }), node('p', { class: 'ci', text: ci(row.accuracyCi) }), node('div', { class: 'progress' }, node('span', { style: `width:${row.accuracy * 100}%` })), node('p', { class: 'muted', text: `${row.correct}/${row.attempts} aciertos · ${row.matches} partidas` }), node('p', { text: `Quesitos por intento: ${row.quesitosWon}/${row.quesitoAttempts} · ${ci(row.quesitoCi)}` }), node('p', { text: `Cobertura histórica: ${row.quesitosWon}/${row.potentialQuesitos} · ${ci(row.quesitoOpportunityCi)}` })]));
  const summary = node('section', { class: 'card stack' }, [node('p', { class: 'eyebrow', text: 'RESUMEN EJECUTIVO' }), node('h2', { text: 'Lectura rápida' }), node('p', { class: 'muted', text: `IC de Wilson al 95%; comparaciones exactas de Fisher con corrección de Holm, α=0,05. ${stats.discards} descartes activos y ${stats.retiredQuestions} preguntas retiradas globalmente, excluidos de precisión.` }), playerCards]);
  const leaderText = stats.significantCategoryLeaders.length ? stats.significantCategoryLeaders.map(row => `${categoryLabel(row)}: ${playerName(row.playerId)} (p ajustada=${row.adjustedPValue.toFixed(3)})`).join(' · ') : 'No hay evidencia suficiente para proclamar un líder por categoría.';
  summary.append(metricPanel('Precisión por categoría', stats.byCategory, categoryLabel), metricPanel('Precisión por nivel', stats.byLevel, row => levelFrom(row.levelKey)?.label ?? row.levelKey), node('div', { class: 'significance' }, [node('strong', { text: 'Liderazgo estadísticamente significativo' }), node('p', { class: 'muted', text: leaderText })]));
  const detailGrid = node('div', { class: 'grid two' }, [metricPanel('Jugador × categoría', stats.byPlayerCategory, row => `${playerName(row.playerId)} · ${categoryLabel(row)}`), metricPanel('Jugador × nivel', stats.byPlayerLevel, row => `${playerName(row.playerId)} · ${levelFrom(row.levelKey)?.label ?? row.levelKey}`), metricPanel('Partida × jugador', stats.byMatchPlayer, row => `${model.matches.find(match => match.matchId === row.matchId)?.name ?? row.matchId} · ${playerName(row.playerId)}`)]);
  const distributions = node('section', { class: 'card stack' }, [node('h3', { text: 'Niveles observados frente al objetivo' })]);
  const distribution = node('div', { class: 'distribution' });
  for (const row of stats.levelDistribution) distribution.append(node('div', {}, [node('strong', { text: `${model.matches.find(match => match.matchId === row.matchId)?.name ?? row.matchId} · ${categoryLabel(row)} · ${levelFrom(row.levelKey)?.label ?? row.levelKey}` }), node('div', { class: 'dual-bar' }, [node('span', { style: `width:${row.observedShare * 100}%` }), node('i', { style: `left:${row.targetShare * 100}%` })]), node('small', { class: 'muted', text: `${row.observed}/${row.total} · observado ${pct(row.observedShare)} · objetivo ${pct(row.targetShare)} · ${row.inferenceAvailable ? `p=${row.goodnessOfFitPValue.toFixed(3)}${row.significantDeviation ? ' · desviación significativa' : ''}` : 'muestra insuficiente para contraste χ²'}` })]));
  distributions.append(distribution);
  const temporal = metricPanel('Evolución temporal', stats.temporal, row => `${row.day} · ${playerName(row.playerId)}`);
  elements.stats.append(summary, detailGrid, distributions, temporal);
}

function renderBase() {
  if (!model) return;
  elements.base.replaceChildren();
  if (model.seed.error) elements.base.append(node('div', { class: 'warning', text: `Los CSV actuales se han rechazado y el servidor mantiene la última semilla válida: ${model.seed.error}` }));
  elements.base.append(node('div', { class: 'grid three' }, [node('article', { class: 'card' }, [node('div', { class: 'kpi', text: String(model.base.questionCount) }), node('p', { text: 'registros canónicos' })]), node('article', { class: 'card' }, [node('div', { class: 'kpi', text: String(model.base.activeQuestionCount) }), node('p', { text: 'preguntas operativas' })]), node('article', { class: 'card' }, [node('div', { class: 'kpi', text: String(model.base.globalRetirements) }), node('p', { text: 'retiradas globales' })]) ]));
  const cards = node('div', { class: 'stock-cards' });
  for (const category of model.categories.filter(item => item.active)) for (const row of model.base.stock.filter(row => row.bankId === category.bankId && row.categoryId === category.categoryId)) {
    const level = model.levels.find(level => level.levelKey === row.levelKey);
    const count = row.count;
    cards.append(node('article', { class: `stock-card${count === 0 ? ' zero' : count <= 5 ? ' low' : ''}` }, [node('div', { class: 'badges' }, node('span', { class: 'category-dot', style: `--category-color:${category.color}` })), node('strong', { text: `${category.label} · ${level.label}` }), node('div', { class: 'kpi', text: String(count) }), node('small', { class: 'muted', text: count === 0 ? 'Agotado · reponer' : count <= 5 ? 'Stock bajo' : 'Disponible' })]));
  }
  elements.base.append(node('section', { class: 'stack' }, [node('h3', { text: 'Stock por categoría y nivel' }), cards]), node('article', { class: 'card' }, [node('h3', { text: 'Versiones activas' }), node('p', { class: 'mono muted', text: `build ${model.versions.buildVersion}\nseed ${model.versions.seedVersion}\nschema ${model.versions.schemaVersion}\nevent ${model.versions.eventSchemaVersion}\nrules ${model.versions.rulesVersion}` })]));
}

async function renderDiagnostics() {
  elements.diagnostics.className = 'loading-card'; elements.diagnostics.textContent = 'Comprobando base, eventos y proyecciones…';
  const result = await get('/api/diagnostics');
  elements.diagnostics.className = 'stack'; elements.diagnostics.replaceChildren(node('div', { class: result.ok ? 'notice good-notice' : 'warning', text: result.ok ? `Integridad correcta · ${result.summary.questionCount} preguntas · ${result.summary.eventCount} eventos · revisión ${result.summary.revision}` : `${result.errors.length} incidencias requieren atención.` }));
  const renderList = (title, rows, warning = false) => {
    if (!rows.length) return;
    const list = node('div', { class: 'diagnostic-list' });
    for (const row of rows) list.append(node('div', { class: `diagnostic-item${warning ? ' warning-item' : ''}` }, [node('strong', { text: row.type }), node('div', { class: 'mono', text: row.id }), node('small', { text: row.detail })]));
    elements.diagnostics.append(node('section', { class: 'card stack' }, [node('h3', { text: title }), list]));
  };
  renderList('Incidencias', result.errors);
  renderList('Alertas operativas', result.warnings, true);
}

async function setView(name) {
  currentView = name;
  elements.tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.view === name));
  elements.views.forEach(view => view.classList.toggle('active', view.id === `view-${name}`));
  if (name === 'stats') await runAction(renderStatistics);
  if (name === 'diagnostics') await runAction(renderDiagnostics);
}

async function exportBackup() {
  const token = elements.adminToken.value;
  const { payload } = await adminGet('/api/admin/backup', token);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob); link.download = `trivial-backup-${new Date().toISOString().slice(0, 10)}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function adminAction(path, payload = {}) {
  await post(path, payload, elements.adminToken.value);
  currentMatchId = null; detail = null;
  await refreshGame();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').then(registration => {
    const inspect = worker => { if (worker?.state === 'installed' && navigator.serviceWorker.controller) { waitingWorker = worker; elements.updateBanner.hidden = false; } };
    if (registration.waiting) { waitingWorker = registration.waiting; elements.updateBanner.hidden = false; }
    registration.addEventListener('updatefound', () => registration.installing?.addEventListener('statechange', () => inspect(registration.installing)));
  }).catch(console.warn);
}

elements.tabs.forEach(tab => tab.onclick = () => setView(tab.dataset.view));
elements.newMatch.onclick = openMatchDialog;
elements.bank.onchange = () => buildDialog(elements.bank.value);
elements.newForm.onsubmit = createMatch;
elements.discardForm.onsubmit = event => { event.preventDefault(); const form = new FormData(elements.discardForm); elements.discardDialog.close(); gameAction({ action: 'discard', reason: form.get('reason'), note: String(form.get('note') || '') }).then(() => elements.discardForm.reset()); };
$$('[data-close]').forEach(button => button.onclick = () => document.getElementById(button.dataset.close).close());
elements.picker.onchange = () => runAction(async () => { currentMatchId = elements.picker.value; selectedCategoryId = null; selectedQuesito = false; selectedRespondentId = null; await loadDetail(); });
$('#refresh-stats').onclick = () => runAction(renderStatistics);
$('#run-diagnostics').onclick = () => runAction(renderDiagnostics);
$('#export-backup').onclick = () => runAction(exportBackup);
elements.importBackup.onchange = () => runAction(async () => { const file = elements.importBackup.files[0]; if (!file) return; const payload = JSON.parse(await file.text()); await adminAction('/api/admin/restore', payload); elements.importBackup.value = ''; toast('Copia restaurada y validada.'); });
$('#reload-seed').onclick = () => runAction(async () => { await adminAction('/api/admin/reload-seed'); toast('CSV validados y sincronizados.'); });
$('#reset-base').onclick = () => runAction(async () => { if (!confirm('¿Eliminar todas las partidas web y retiradas globales y volver exactamente a los CSV actuales?')) return; await adminAction('/api/admin/reset'); toast('Base original restaurada.'); });
$('#apply-update').onclick = () => { waitingWorker?.postMessage({ type: 'SKIP_WAITING' }); location.reload(); };
window.addEventListener('online', setOperationalStatus);
window.addEventListener('offline', () => setConnection(false, 'Sin conexión'));

async function pollRevision() {
  if (busy || document.hidden || !navigator.onLine) return;
  try {
    const revision = await get('/api/revision');
    setOperationalStatus();
    if (revision.revision !== lastRevision) {
      await refreshGame();
      if (currentView === 'stats') await renderStatistics();
      if (currentView === 'diagnostics') await renderDiagnostics();
    }
  } catch {
    setConnection(false, 'Servidor no disponible');
  }
}

try {
  await refreshGame();
  setOperationalStatus();
  document.body.setAttribute('aria-busy', 'false');
  registerServiceWorker();
  setInterval(pollRevision, 3000);
} catch (error) {
  console.error(error);
  setConnection(false, 'Servidor no disponible');
  elements.game.className = 'warning';
  elements.game.textContent = `No se pudo iniciar: ${error.message}`;
}
