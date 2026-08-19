import { db } from './db.js';
import { BUILD_VERSION, EVENT_TYPES, RULES_VERSION, SCHEMA_VERSION } from './config.js';
import { availableQuestions, deriveLiveState, drawOrdinal, freezeLevelWeights, getActiveEvents, makeMatchSeed, quesitosByPlayer, redoCandidate, resultEvents, seenQuestionKeys, selectQuestionForDraw, selectReplacementQuestion, undoCandidate, validateMatchConfiguration, winnersForClose } from './domain.js';
import { createBackup, validateBackup } from './backup.js';
import { diagnose } from './diagnostics.js';
import { downloadJson } from './import-export.js';
import { computeStats, pct } from './stats.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const elements = {
  tabs: $$('.tab'), views: $$('.view'), game: $('#game-root'), stats: $('#stats-root'), base: $('#base-root'), diagnostics: $('#diagnostics-root'),
  picker: $('#match-picker'), newButton: $('#new-match-btn'), dialog: $('#new-match-dialog'), form: $('#new-match-form'), bank: $('#new-match-bank'),
  players: $('#new-match-players'), categories: $('#new-match-categories'), levels: $('#new-match-levels'), closeDialog: $('#close-match-dialog'), cancel: $('#cancel-match'),
  exportBackup: $('#export-backup'), importBackup: $('#import-backup'), reset: $('#reset-base'), runDiagnostics: $('#run-diagnostics'), toast: $('#toast'),
};

let model = { banks: [], categories: [], levels: [], questions: [], players: [], matches: [], participants: [], attempts: [], exposures: [], events: [], meta: [] };
let currentMatchId = null;
let selectedPlayerId = null;
let selectedCategoryId = null;
let selectedQuesito = false;
let busy = false;
let toastTimer;

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
  toastTimer = setTimeout(() => elements.toast.classList.remove('show'), 3500);
}

async function runAction(task) {
  if (busy) return;
  busy = true;
  document.body.classList.add('busy');
  try { await task(); }
  catch (error) { console.error(error); toast(error.message || 'No se pudo completar la operación.'); }
  finally { busy = false; document.body.classList.remove('busy'); }
}

const matchById = (id) => model.matches.find((match) => match.matchId === id);
const playerName = (id) => model.players.find((player) => player.playerId === id)?.name ?? id;
const categoryFor = (bankId, id) => model.categories.find((category) => category.bankId === bankId && category.categoryId === id);
const levelFor = (id) => model.levels.find((level) => level.levelKey === id);
const questionFor = (key) => model.questions.find((question) => question.questionKey === key);
const eventsFor = (matchId) => model.events.filter((event) => event.matchId === matchId);

async function load() {
  const stores = Object.keys(model);
  const values = await Promise.all(stores.map((store) => db.getAll(store)));
  model = Object.fromEntries(stores.map((store, index) => [store, values[index]]));
  model.matches.sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')) || right.matchId.localeCompare(left.matchId));
  if (!currentMatchId || !matchById(currentMatchId)) currentMatchId = model.matches.find((match) => deriveLiveState(match, eventsFor(match.matchId)).status === 'open')?.matchId ?? model.matches[0]?.matchId ?? null;
}

async function refresh() {
  await load();
  renderPicker();
  renderGame();
  renderStats();
  renderBase();
}

function setView(name) {
  elements.tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.view === name));
  elements.views.forEach((view) => view.classList.toggle('active', view.id === `view-${name}`));
  if (name === 'diagnostics') runDiagnostics();
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
    const status = deriveLiveState(match, eventsFor(match.matchId)).status;
    const option = node('option', { value: match.matchId, text: `${match.name} · ${match.playerIds.map(playerName).join('+')} · ${status === 'closed' ? 'cerrada' : 'abierta'}` });
    option.selected = match.matchId === currentMatchId;
    elements.picker.append(option);
  }
}

function matchAvailable(match, categoryId, events = eventsFor(match.matchId)) {
  return availableQuestions({ questions: model.questions, bankId: match.bankId, categoryId, enabledLevelKeys: match.enabledLevelKeys, seenKeys: seenQuestionKeys(events) });
}

function matchQuesitos(match, events) {
  if (match.source === 'historical_seed') return quesitosByPlayer(model.attempts.filter((attempt) => attempt.matchId === match.matchId && attempt.active !== false));
  return quesitosByPlayer(resultEvents(events));
}

function renderGame() {
  elements.game.replaceChildren();
  const match = matchById(currentMatchId);
  if (!match) { elements.game.append(node('div', { class: 'empty', text: 'Crea una partida para empezar.' })); return; }
  const events = eventsFor(match.matchId);
  const live = deriveLiveState(match, events);
  const categories = match.enabledCategoryIds.map((id) => categoryFor(match.bankId, id)).filter(Boolean);
  const layout = node('div', { class: 'grid two' });
  const main = node('div', { class: 'card' });
  const side = node('aside', { class: 'card' });
  main.append(node('p', { class: 'eyebrow', text: live.status === 'closed' ? 'PARTIDA CERRADA' : live.currentDraw ? 'PREGUNTA PENDIENTE' : 'NUEVO TURNO' }), node('h3', { text: live.status === 'closed' ? 'Partida finalizada' : live.currentDraw ? 'Pregunta en juego' : 'Elige la categoría' }), node('p', { class: 'muted', text: `Turno actual: ${playerName(live.currentTurnPlayerId)} · ${categories.length} categorías · niveles con pesos fijos 70/20/10` }));
  if (live.status === 'closed') renderClosed(main, match, live);
  else if (live.currentDraw) renderQuestion(main, match, live);
  else renderDraw(main, match, events, categories);
  renderSidebar(side, match, events, live, categories);
  layout.append(main, side);
  elements.game.append(layout);
}

function renderClosed(root, match, live) {
  const winners = live.close?.winners ?? winnersForClose(match, eventsFor(match.matchId));
  root.append(node('p', { class: 'notice', text: `Motivo: ${live.close?.reason ?? match.closeReason ?? 'cierre histórico'}. ${winners.length ? `Mejor puntuación: ${winners.map(playerName).join(' y ')}${winners.length > 1 ? ' (empate)' : ''}.` : ''}` }));
}

function renderDraw(root, match, events, categories) {
  const live = deriveLiveState(match, events);
  root.append(node('p', { class: 'turn-banner', text: `Turno actual · ${playerName(live.currentTurnPlayerId)}` }), node('p', { text: '1. Categoría' }));
  const categoryGrid = node('div', { class: 'category-grid', 'data-testid': 'category-picker' });
  for (const category of categories) {
    const stock = matchAvailable(match, category.categoryId, events).length;
    categoryGrid.append(node('button', { type: 'button', class: `category-button${selectedCategoryId === category.categoryId ? ' active' : ''}${stock ? '' : ' stock-zero'}`, disabled: stock === 0, 'data-category-id': category.categoryId, onclick: () => { selectedCategoryId = category.categoryId; selectedQuesito = false; renderGame(); } }, [node('span', { class: 'category-dot', style: `--category-color:${category.color}` }), `${category.emoji} ${category.label} · ${stock}`]));
  }
  root.append(categoryGrid);
  const owned = matchQuesitos(match, events).get(live.currentTurnPlayerId)?.has(selectedCategoryId);
  const label = node('label', { class: 'quesito-toggle' });
  const checkbox = node('input', { id: 'quesito-toggle', type: 'checkbox', checked: selectedQuesito, disabled: !selectedCategoryId || owned, onchange: (event) => { selectedQuesito = event.target.checked; } });
  label.append(checkbox, owned ? '2. Quesito ya obtenido (no se puede duplicar)' : '2. Este turno es un intento de quesito');
  const canDraw = Boolean(selectedCategoryId && matchAvailable(match, selectedCategoryId, events).length);
  const drawButton = node('button', { id: 'draw-question', class: 'primary', type: 'button', text: 'Sacar pregunta', disabled: !canDraw, onclick: () => drawQuestion(match) });
  root.append(label, node('div', { class: 'toolbar' }, drawButton));
  if (!categories.some((category) => matchAvailable(match, category.categoryId, events).length)) root.append(node('p', { class: 'warning', text: 'No queda stock para esta configuración. Cierra la partida o crea otra con más niveles.' }));
}

function drawQuestion(match) {
  const categoryId = selectedCategoryId;
  const quesitoAttempt = selectedQuesito;
  runAction(async () => {
    let exhausted = null;
    await db.commitMatch(match.matchId, (events) => {
      const live = deriveLiveState(match, events);
      const playerId = live.currentTurnPlayerId;
      if (live.status !== 'open') throw new Error('La partida está cerrada.');
      if (live.currentDraw) throw new Error('Ya hay una pregunta pendiente.');
      if (!match.playerIds.includes(playerId) || !match.enabledCategoryIds.includes(categoryId)) throw new Error('Elige una categoría válida.');
      const ordinal = drawOrdinal(events);
      const available = matchAvailable(match, categoryId, events);
      const pick = selectQuestionForDraw({ questions: available, categoryId, playerId, enabledLevelKeys: match.enabledLevelKeys, frozenWeights: match.levelWeights, matchSeed: match.seed, drawOrdinal: ordinal });
      if (!pick) throw new Error('No queda stock elegible.');
      if (pick.exhausted) {
        exhausted = pick.levelKey;
        return [{ type: EVENT_TYPES.STOCK_EXHAUSTED, actionId: `stock:${ordinal}`, idempotencyKey: `${match.matchId}:stock:${ordinal}`, payload: { drawOrdinal: ordinal, randomUnit: pick.randomUnit, effectiveWeights: pick.effectiveWeights, playerId, categoryId, levelKey: pick.levelKey } }];
      }
      return [{ type: EVENT_TYPES.QUESTION_DRAWN, actionId: `draw:${ordinal}`, idempotencyKey: `${match.matchId}:draw:${ordinal}`, payload: { drawOrdinal: ordinal, randomUnit: pick.randomUnit, effectiveWeights: pick.effectiveWeights, playerId, turnPlayerId: playerId, categoryId, levelKey: pick.levelKey, questionKey: pick.question.questionKey, quesitoAttempt: Boolean(quesitoAttempt) } }];
    });
    await refresh();
    if (exhausted) toast(`Stock agotado: ${categoryFor(match.bankId, categoryId)?.label ?? categoryId} · ${levelFor(exhausted)?.label ?? exhausted}. Solicita reposición al desarrollador.`);
  });
}

function renderQuestion(root, match, live) {
  const draw = live.currentDraw;
  const question = questionFor(draw.questionKey);
  if (!question) { root.append(node('p', { class: 'warning', text: `Pregunta no encontrada (${draw.questionKey}). Ejecuta Diagnóstico.` })); return; }
  const category = categoryFor(match.bankId, draw.categoryId);
  const level = levelFor(draw.levelKey);
  root.append(node('div', { class: 'badges' }, [node('span', { class: 'badge' }, [node('span', { class: 'category-dot', style: `--category-color:${category?.color ?? '#fff'}` }), `${category?.emoji ?? ''} ${category?.label ?? draw.categoryId}`]), node('span', { class: 'badge', text: `Nivel: ${level?.label ?? draw.levelKey}` }), node('span', { class: 'badge', text: `Turno: ${playerName(draw.turnPlayerId ?? draw.playerId)}` }), draw.quesitoAttempt ? node('span', { class: 'badge', text: 'Intento de quesito' }) : null]));
  const card = node('div', { class: 'question-card' }, [node('div', { class: 'question-text', text: question.prompt }), live.answerRevealed ? node('div', { class: 'answer-box', 'data-testid': 'answer' }, [node('strong', { text: 'Respuesta: ' }), question.answer, node('p', { class: 'muted', text: question.explanation })]) : null]);
  const controls = node('div', { class: 'toolbar' });
  if (!live.answerRevealed) controls.append(node('button', { id: 'reveal-answer', type: 'button', text: 'Mostrar respuesta', onclick: () => revealAnswer(match, draw) }));
  else {
    if (!match.playerIds.includes(selectedPlayerId)) selectedPlayerId = draw.turnPlayerId ?? draw.playerId;
    const respondent = node('div', { class: 'respondent-picker', 'data-testid': 'respondent-picker' }, [node('strong', { text: '¿Quién ha respondido?' })]);
    for (const playerId of match.playerIds) respondent.append(node('button', { type: 'button', class: `player-button${selectedPlayerId === playerId ? ' active' : ''}`, text: playerName(playerId), 'data-respondent-id': playerId, onclick: () => { selectedPlayerId = playerId; renderGame(); } }));
    root.append(respondent);
    controls.append(node('button', { id: 'record-correct', class: 'good', type: 'button', text: 'Acierto', onclick: () => recordResult(match, draw, true) }), node('button', { id: 'record-wrong', class: 'danger', type: 'button', text: 'Fallo', onclick: () => recordResult(match, draw, false) }), node('button', { id: 'discard-question', type: 'button', text: 'Descartar comprometida', onclick: () => discardQuestion(match, draw) }));
  }
  root.append(card, controls);
}

function revealAnswer(match, draw) {
  runAction(async () => {
    await db.commitMatch(match.matchId, (events) => {
      const live = deriveLiveState(match, events);
      if (live.currentDraw?.eventId !== draw.eventId) throw new Error('La pregunta pendiente cambió en otra pestaña.');
      if (live.answerRevealed) return [];
      return [{ type: EVENT_TYPES.ANSWER_REVEALED, actionId: `reveal:${draw.eventId}`, idempotencyKey: `${match.matchId}:reveal:${draw.eventId}`, payload: { drawEventId: draw.eventId, questionKey: draw.questionKey } }];
    });
    await refresh();
  });
}

function recordResult(match, draw, correct) {
  const respondentId = selectedPlayerId;
  runAction(async () => {
    await db.commitMatch(match.matchId, (events) => {
      const live = deriveLiveState(match, events);
      if (live.currentDraw?.eventId !== draw.eventId || !live.answerRevealed) throw new Error('Primero muestra la respuesta de la pregunta pendiente.');
      const owned = quesitosByPlayer(resultEvents(events));
      if (!match.playerIds.includes(respondentId)) throw new Error('Indica qué jugador ha respondido.');
      const quesitoWon = Boolean(correct && draw.quesitoAttempt && !owned.get(respondentId)?.has(draw.categoryId));
      const actionId = `result:${draw.eventId}`;
      const result = { type: EVENT_TYPES.RESULT_RECORDED, actionId, idempotencyKey: `${match.matchId}:terminal:${draw.eventId}`, payload: { drawEventId: draw.eventId, questionKey: draw.questionKey, playerId: respondentId, turnPlayerId: draw.turnPlayerId ?? draw.playerId, categoryId: draw.categoryId, levelKey: draw.levelKey, correct: Boolean(correct), quesitoAttempt: draw.quesitoAttempt, quesitoWon } };
      const won = new Set(owned.get(respondentId) ?? []);
      if (quesitoWon) won.add(draw.categoryId);
      if (match.enabledCategoryIds.every((categoryId) => won.has(categoryId))) return [result, { type: EVENT_TYPES.MATCH_CLOSED, actionId, payload: { reason: 'victoria', winners: [respondentId] } }];
      return [result];
    });
    selectedPlayerId = null; selectedCategoryId = null; selectedQuesito = false;
    await refresh();
  });
}

function discardQuestion(match, draw) {
  runAction(async () => {
    let replaced = false;
    await db.commitDiscard(match.matchId, draw.questionKey, (events) => {
      const live = deriveLiveState(match, events);
      if (live.currentDraw?.eventId !== draw.eventId || !live.answerRevealed) throw new Error('Primero muestra la respuesta de la pregunta pendiente.');
      const actionId = `discard:${draw.eventId}`;
      const specifications = [{ type: EVENT_TYPES.QUESTION_DISCARDED, actionId, idempotencyKey: `${match.matchId}:terminal:${draw.eventId}`, payload: { drawEventId: draw.eventId, questionKey: draw.questionKey, playerId: draw.turnPlayerId ?? draw.playerId, categoryId: draw.categoryId, levelKey: draw.levelKey, quesitoAttempt: draw.quesitoAttempt, retiredLocally: true } }];
      const ordinal = drawOrdinal(events);
      const available = matchAvailable(match, draw.categoryId, events);
      const replacement = selectReplacementQuestion({ questions: available, previousLevelKey: draw.levelKey, categoryId: draw.categoryId, playerId: draw.turnPlayerId ?? draw.playerId, enabledLevelKeys: match.enabledLevelKeys, frozenWeights: match.levelWeights, matchSeed: match.seed, drawOrdinal: ordinal });
      if (replacement?.question) {
        replaced = true;
        specifications.push({ type: EVENT_TYPES.QUESTION_DRAWN, actionId, payload: { drawOrdinal: ordinal, randomUnit: replacement.randomUnit, effectiveWeights: replacement.effectiveWeights, playerId: draw.turnPlayerId ?? draw.playerId, turnPlayerId: draw.turnPlayerId ?? draw.playerId, categoryId: draw.categoryId, levelKey: replacement.levelKey, questionKey: replacement.question.questionKey, quesitoAttempt: draw.quesitoAttempt, replacementForEventId: draw.eventId } });
      } else if (replacement?.exhausted) {
        specifications.push({ type: EVENT_TYPES.STOCK_EXHAUSTED, actionId, payload: { drawOrdinal: ordinal, randomUnit: replacement.randomUnit, effectiveWeights: replacement.effectiveWeights, playerId: draw.turnPlayerId ?? draw.playerId, categoryId: draw.categoryId, levelKey: replacement.levelKey, replacementForEventId: draw.eventId } });
      }
      return specifications;
    });
    await refresh();
    toast(replaced ? 'Pregunta descartada; sustitución generada.' : 'Pregunta descartada; no queda sustitución disponible.');
  });
}

function renderSidebar(root, match, events, live, categories) {
  root.append(node('p', { class: 'eyebrow', text: 'MARCADOR' }), node('p', { class: 'turn-banner', text: `Turno actual · ${playerName(live.currentTurnPlayerId)}` }));
  const quesitos = matchQuesitos(match, events);
  const results = resultEvents(events);
  for (const playerId of match.playerIds) {
    const badges = node('div', { class: 'badges' });
    for (const category of categories) badges.append(node('span', { class: 'badge', text: `${quesitos.get(playerId)?.has(category.categoryId) ? '●' : '○'} ${category.emoji} ${category.label}` }));
    const playerResults = results.filter((event) => event.payload?.playerId === playerId);
    root.append(node('div', { class: `quesito-row${live.currentTurnPlayerId === playerId ? ' current-turn' : ''}` }, [node('strong', { text: `${playerName(playerId)} · ${playerResults.filter((event) => event.payload.correct).length}✓ ${playerResults.filter((event) => !event.payload.correct).length}✕` }), badges]));
  }
  const depleted = [];
  for (const category of categories) for (const levelKey of match.enabledLevelKeys) if (!matchAvailable(match, category.categoryId, events).some((question) => question.levelKey === levelKey)) depleted.push(`${category.label} · ${levelFor(levelKey)?.label ?? levelKey}`);
  if (depleted.length) root.append(node('div', { class: 'warning stock-alert' }, [node('strong', { text: 'Reposición necesaria' }), node('p', { text: `${depleted.join(' · ')}. Solicítala al desarrollador (ChatGPT Work).` })]));
  const undo = undoCandidate(events);
  const redo = redoCandidate(events);
  root.append(node('hr'), node('div', { class: 'toolbar' }, [node('button', { id: 'undo-action', type: 'button', text: 'Deshacer', disabled: !undo, onclick: () => undoAction(match) }), node('button', { id: 'redo-action', type: 'button', text: 'Rehacer', disabled: !redo, onclick: () => redoAction(match) })]));
  if (live.status === 'open') {
    const reason = node('select', { id: 'close-reason', 'aria-label': 'Motivo de cierre' }, [node('option', { value: 'manual', text: 'Cierre manual' }), node('option', { value: 'time_limit', text: 'Tiempo límite' }), node('option', { value: 'interruption', text: 'Interrupción' }), node('option', { value: 'other', text: 'Otro motivo' })]);
    root.append(node('hr'), node('label', {}, ['Finalizar partida', reason]), node('button', { id: 'close-match', class: 'danger full-width', type: 'button', text: 'Cerrar partida', disabled: Boolean(live.currentDraw), onclick: () => closeMatch(match, reason.value) }));
  }
  root.append(node('hr'), node('p', { class: 'muted mono', text: `rules_version: ${match.rulesVersion ?? 'histórica'}\nseed: ${match.seed}\nschema: ${SCHEMA_VERSION}` }));
}

function undoAction(match) {
  runAction(async () => {
    await db.commitMatch(match.matchId, (events) => {
      const candidate = undoCandidate(events);
      if (!candidate) return [];
      return [{ type: EVENT_TYPES.EVENT_REVERTED, actionId: `undo:${candidate.targetEventIds.join('+')}`, idempotencyKey: `${match.matchId}:undo:${events.length}:${candidate.targetEventIds.join('+')}`, payload: { targetEventIds: candidate.targetEventIds, label: candidate.label } }];
    });
    await refresh();
  });
}

function redoAction(match) {
  runAction(async () => {
    await db.commitMatch(match.matchId, (events) => {
      const candidate = redoCandidate(events);
      if (!candidate) return [];
      return [{ type: EVENT_TYPES.EVENT_RESTORED, actionId: `redo:${candidate.targetEventIds.join('+')}`, idempotencyKey: `${match.matchId}:redo:${events.length}:${candidate.targetEventIds.join('+')}`, payload: { targetEventIds: candidate.targetEventIds, label: candidate.label } }];
    });
    await refresh();
  });
}

function closeMatch(match, reason) {
  runAction(async () => {
    await db.commitMatch(match.matchId, (events) => {
      const live = deriveLiveState(match, events);
      if (live.currentDraw) throw new Error('Resuelve o descarta la pregunta pendiente antes de cerrar.');
      if (live.status === 'closed') return [];
      return [{ type: EVENT_TYPES.MATCH_CLOSED, actionId: `close:${events.length}`, idempotencyKey: `${match.matchId}:close`, payload: { reason, winners: winnersForClose(match, events) } }];
    });
    await refresh();
  });
}

function buildDialogForBank(bankId) {
  elements.players.replaceChildren(); elements.categories.replaceChildren(); elements.levels.replaceChildren();
  for (const player of model.players.filter((item) => item.active !== false)) elements.players.append(node('label', {}, [node('input', { type: 'checkbox', name: 'player', value: player.playerId }), player.name]));
  for (const category of model.categories.filter((item) => item.bankId === bankId && item.active !== false)) elements.categories.append(node('label', {}, [node('input', { type: 'checkbox', name: 'category', value: category.categoryId, checked: true }), `${category.emoji} ${category.label}`]));
  const usedLevels = new Set(model.questions.filter((question) => question.bankId === bankId).map((question) => question.levelKey));
  for (const level of model.levels.filter((item) => usedLevels.has(item.levelKey)).sort((a, b) => a.order - b.order)) elements.levels.append(node('label', {}, [node('input', { type: 'checkbox', name: 'level', value: level.levelKey, checked: true }), level.label]));
}

function openDialog() {
  elements.bank.replaceChildren(...model.banks.map((bank) => node('option', { value: bank.bankId, text: bank.name })));
  buildDialogForBank(elements.bank.value);
  elements.dialog.showModal();
}

function nextMatchId() {
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const suffix = globalThis.crypto?.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(16).slice(2, 10);
  return `M${day}-${suffix}`;
}

function createMatch(event) {
  event.preventDefault();
  runAction(async () => {
    const bankId = elements.bank.value;
    const playerIds = $$('input[name="player"]:checked', elements.form).map((input) => input.value);
    const categoryIds = $$('input[name="category"]:checked', elements.form).map((input) => input.value);
    const levelKeys = $$('input[name="level"]:checked', elements.form).map((input) => input.value);
    const validation = validateMatchConfiguration({ bankId, playerIds, categoryIds, levelKeys, questions: model.questions, availablePlayerIds: model.players.filter((player) => player.active !== false).map((player) => player.playerId) });
    if (!validation.ok) throw new Error(validation.errors.join(' '));
    const matchId = nextMatchId();
    const seed = makeMatchSeed({ matchId, playerIds, categoryIds, levelKeys, bankId });
    const levelWeights = freezeLevelWeights({ levels: model.levels, categoryIds, enabledLevelKeys: levelKeys });
    const form = new FormData(elements.form);
    const match = { matchId, name: String(form.get('name') || '').trim() || `Partida ${new Date().toLocaleDateString('es-ES')}`, bankId, playerIds, enabledCategoryIds: categoryIds, enabledLevelKeys: levelKeys, rulesVersion: RULES_VERSION, levelWeights, seed, status: 'open', createdAt: new Date().toISOString(), source: 'web', seedOwned: false };
    const participants = playerIds.map((playerId, index) => ({ matchPlayerId: `${matchId}|${playerId}`, matchId, playerId, seatNo: index + 1, active: true, seedOwned: false }));
    await db.createMatch(match, participants, { type: EVENT_TYPES.MATCH_CREATED, actionId: 'match-created', idempotencyKey: `${matchId}:created`, payload: { matchId, bankId, playerIds, enabledCategoryIds: categoryIds, enabledLevelKeys: levelKeys, rulesVersion: RULES_VERSION, seed, levelWeights, createdAt: match.createdAt } });
    currentMatchId = matchId; selectedPlayerId = null; selectedCategoryId = null; selectedQuesito = false;
    elements.dialog.close(); elements.form.reset();
    await refresh(); setView('game');
  });
}

function renderStats() {
  elements.stats.replaceChildren();
  const stats = computeStats(model);
  if (!stats.byPlayer.length) { elements.stats.append(node('div', { class: 'empty', text: 'Sin resultados computables.' })); return; }
  const categoryLabel = (id) => model.categories.find((category) => category.categoryId === id)?.label ?? id;
  const ci = (interval) => `IC 95% ${pct(interval.low)}–${pct(interval.high)}`;
  const summary = node('section', { class: 'card executive-summary' }, [node('p', { class: 'eyebrow', text: 'RESUMEN EJECUTIVO' }), node('h3', { text: 'Lectura rápida' }), node('p', { class: 'muted', text: `Estimaciones binomiales con intervalos de Wilson al 95%. Comparaciones entre jugadores: prueba z bilateral, α = 0,05. ${stats.discards} descartes activos, excluidos de precisión.` })]);
  const playerCards = node('div', { class: 'grid three compact-grid' });
  for (const row of stats.byPlayer.sort((a, b) => a.playerId.localeCompare(b.playerId))) playerCards.append(node('article', { class: 'metric-card' }, [node('strong', { text: playerName(row.playerId) }), node('div', { class: 'kpi', text: pct(row.accuracy) }), node('p', { class: 'ci-label', text: ci(row.accuracyCi) }), node('div', { class: 'progress', 'aria-label': `Precisión ${pct(row.accuracy)}` }, node('span', { style: `width:${row.accuracy * 100}%` })), node('p', { class: 'muted', text: `${row.correct}/${row.attempts} aciertos · ${row.matches ?? 0} partidas` }), node('p', { text: `Quesitos: ${row.quesitosWon}/${row.potentialQuesitos} posibles (${pct(row.quesitoOpportunityRate)})` }), node('p', { class: 'ci-label', text: ci(row.quesitoOpportunityCi) })]));
  summary.append(playerCards, metricPanel('Precisión por categoría', stats.byCategory, (row) => categoryLabel(row.categoryId), ci), metricPanel('Precisión por nivel', stats.byLevel, (row) => levelFor(row.levelKey)?.label ?? row.levelKey, ci));
  const leaders = stats.significantCategoryLeaders;
  summary.append(node('div', { class: 'significance-box' }, [node('strong', { text: 'Jugador más preciso por categoría' }), node('p', { class: 'muted', text: leaders.length ? leaders.map((row) => `${categoryLabel(row.categoryId)}: ${playerName(row.playerId)} (p=${row.pValue.toFixed(3)})`).join(' · ') : 'No hay diferencias significativas con los datos actuales; no se proclama ningún líder.' })]));
  const detail = node('section', { class: 'stats-details' }, [node('h3', { text: 'Análisis completo' })]);
  detail.append(metricPanel('Jugador × categoría', stats.byPlayerCategory, (row) => `${playerName(row.playerId)} · ${categoryLabel(row.categoryId)}`, ci), metricPanel('Jugador × nivel', stats.byPlayerLevel, (row) => `${playerName(row.playerId)} · ${levelFor(row.levelKey)?.label ?? row.levelKey}`, ci), metricPanel('Partida × jugador', stats.byMatchPlayer, (row) => `${matchById(row.matchId)?.name ?? row.matchId} · ${playerName(row.playerId)}`, ci));
  const distributions = node('div', { class: 'card stats-card' }, [node('h3', { text: 'Niveles observados vs objetivo' })]);
  for (const row of stats.levelDistribution) distributions.append(node('div', { class: 'distribution-row' }, [node('strong', { text: `${matchById(row.matchId)?.name ?? row.matchId} · ${categoryLabel(row.categoryId)} · ${levelFor(row.levelKey)?.label ?? row.levelKey}` }), node('div', { class: 'dual-bars' }, [node('span', { style: `width:${row.observedShare * 100}%`, title: `Observado ${pct(row.observedShare)}` }), node('i', { style: `left:${row.targetShare * 100}%`, title: `Objetivo ${pct(row.targetShare)}` })]), node('small', { text: `${row.observed} observadas · ${pct(row.observedShare)} frente a ${pct(row.targetShare)} objetivo` })]));
  const temporal = node('div', { class: 'card stats-card' }, [node('h3', { text: 'Evolución temporal' })]);
  for (const row of stats.temporal) temporal.append(node('div', { class: 'timeline-stat' }, [node('span', { text: row.day }), node('strong', { text: playerName(row.playerId) }), node('span', { text: `${row.correct}/${row.attempts} · ${pct(row.attempts ? row.correct / row.attempts : 0)}` })]));
  detail.append(distributions, temporal);
  elements.stats.append(summary, detail);
}

function metricPanel(title, rows, label, ci) {
  const card = node('div', { class: 'card stats-card metric-panel' }, [node('h3', { text: title })]);
  if (!rows.length) { card.append(node('p', { class: 'muted', text: 'Sin datos.' })); return card; }
  for (const row of rows) card.append(node('div', { class: 'metric-row' }, [node('div', {}, [node('strong', { text: label(row) }), node('small', { text: `${row.correct}/${row.attempts} · ${ci(row.accuracyCi)}` })]), node('div', { class: 'metric-value', text: pct(row.accuracy) }), node('div', { class: 'progress' }, node('span', { style: `width:${row.accuracy * 100}%` }))]));
  return card;
}

function statsTable(title, headers, rows) {
  const card = node('div', { class: 'card stats-card' }, node('h3', { text: title }));
  if (!rows.length) { card.append(node('p', { class: 'muted', text: 'Sin datos.' })); return card; }
  const table = node('table');
  table.append(node('thead', {}, node('tr', {}, headers.map((header) => node('th', { text: header })))), node('tbody', {}, rows.map((row) => node('tr', {}, row.map((cell) => node('td', { text: cell }))))));
  card.append(table);
  return card;
}

function renderBase() {
  elements.base.replaceChildren();
  const meta = Object.fromEntries(model.meta.map((row) => [row.key, row.value]));
  elements.base.append(node('div', { class: 'grid three' }, [node('div', { class: 'card' }, [node('div', { class: 'kpi', text: String(model.questions.length) }), node('p', { text: 'preguntas en la semilla' })]), node('div', { class: 'card' }, [node('div', { class: 'kpi', text: String(model.questions.filter((question) => question.status === 'active').length) }), node('p', { text: 'activas para partidas nuevas' })]), node('div', { class: 'card' }, [node('div', { class: 'kpi', text: String(model.banks.length) }), node('p', { text: 'bancos disponibles' })])]), node('div', { class: 'card stats-card' }, [node('h3', { text: 'Versiones' }), node('p', { class: 'mono muted', text: `build=${BUILD_VERSION}\nseed_version=${meta.seedVersion ?? meta.seed_version}\nschema_version=${SCHEMA_VERSION}\nrules_version=${RULES_VERSION}` })]));
}

async function runDiagnostics() {
  elements.diagnostics.replaceChildren(node('p', { class: 'muted', text: 'Comprobando integridad…' }));
  const result = diagnose(await db.snapshot());
  const summary = node('div', { class: result.ok ? 'notice good-notice' : 'warning', text: result.ok ? `Integridad correcta · ${result.summary.questionCount} preguntas · ${result.summary.eventCount} eventos · seed ${result.summary.seedVersion} · schema ${result.summary.schemaVersion}` : `${result.errors.length} incidencias encontradas.` });
  elements.diagnostics.replaceChildren(summary);
  if (!result.ok) elements.diagnostics.append(statsTable('Incidencias', ['Tipo', 'ID', 'Detalle'], result.errors.map((error) => [error.type, error.id, error.detail])));
  if (result.warnings.length) elements.diagnostics.append(statsTable('Alertas operativas', ['Tipo', 'ID', 'Detalle'], result.warnings.map((warning) => [warning.type, warning.id, warning.detail])));
}

async function exportBackup() {
  downloadJson(`trivial-backup-${new Date().toISOString().slice(0, 10)}.json`, createBackup(await db.snapshot()));
}

async function importBackup(file) {
  let payload;
  try { payload = JSON.parse(await file.text()); }
  catch { throw new Error('El archivo no contiene JSON válido.'); }
  const validation = validateBackup(payload);
  if (!validation.ok) throw new Error(`Copia rechazada: ${validation.errors.slice(0, 5).map((error) => `${error.type}:${error.id}`).join('; ')}`);
  await db.replaceAll(payload);
  currentMatchId = null; selectedPlayerId = null; selectedCategoryId = null; selectedQuesito = false;
  await refresh(); toast('Copia completa restaurada.');
}

elements.tabs.forEach((tab) => { tab.onclick = () => setView(tab.dataset.view); });
elements.picker.onchange = () => { currentMatchId = elements.picker.value; selectedPlayerId = null; selectedCategoryId = null; selectedQuesito = false; renderGame(); };
elements.newButton.onclick = openDialog;
elements.bank.onchange = () => buildDialogForBank(elements.bank.value);
elements.closeDialog.onclick = elements.cancel.onclick = () => elements.dialog.close();
elements.form.onsubmit = createMatch;
elements.exportBackup.onclick = () => runAction(exportBackup);
elements.importBackup.onchange = () => runAction(async () => { if (elements.importBackup.files[0]) await importBackup(elements.importBackup.files[0]); elements.importBackup.value = ''; });
elements.reset.onclick = () => runAction(async () => { if (!confirm('¿Borrar todo el estado local y volver exactamente a los CSV actuales del repositorio?')) return; await db.resetToSeed(); currentMatchId = null; selectedPlayerId = null; selectedCategoryId = null; selectedQuesito = false; await refresh(); toast('Base original restaurada.'); });
elements.runDiagnostics.onclick = () => runAction(runDiagnostics);
db.onChange(() => { if (!busy) refresh().catch(console.error); });
window.addEventListener('error', (event) => { console.error(event.error ?? event.message); toast('Error de aplicación. Abre Diagnóstico para revisar la integridad.'); });

try {
  await db.init();
  await refresh();
  for (const control of [elements.newButton, elements.exportBackup, elements.importBackup, elements.reset, elements.runDiagnostics]) control.disabled = false;
  document.body.dataset.ready = 'true';
  document.body.setAttribute('aria-busy', 'false');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(console.warn);
} catch (error) {
  console.error(error);
  elements.game.replaceChildren(node('div', { class: 'warning', text: `No se pudo iniciar: ${error.message}` }));
}
