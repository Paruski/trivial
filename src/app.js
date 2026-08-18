import { db } from './db.js';
import { EVENT_TYPES, deriveMatchState, getActiveEvents, getRevertedEventIds, selectNextQuestion, computeStats, makeId } from './domain.js';
import { importBankFromCsv, downloadJson, makeEvent } from './import-export.js';
import { pct, aggregateMatches } from './stats.js';

const els = {
  tabs: [...document.querySelectorAll('.tab')],
  views: [...document.querySelectorAll('.view')],
  gameRoot: document.querySelector('#game-root'),
  banksRoot: document.querySelector('#banks-root'),
  statsRoot: document.querySelector('#stats-root'),
  matchPicker: document.querySelector('#match-picker'),
  newMatchBtn: document.querySelector('#new-match-btn'),
  newMatchDialog: document.querySelector('#new-match-dialog'),
  newMatchForm: document.querySelector('#new-match-form'),
  newMatchBank: document.querySelector('#new-match-bank'),
  newMatchCategories: document.querySelector('#new-match-categories'),
  newMatchLevels: document.querySelector('#new-match-levels'),
  closeMatchDialog: document.querySelector('#close-match-dialog'),
  cancelMatch: document.querySelector('#cancel-match'),
  bankFile: document.querySelector('#bank-file'),
  exportBackup: document.querySelector('#export-backup'),
  importBackup: document.querySelector('#import-backup'),
  toast: document.querySelector('#toast'),
};

let model = { banks: [], questions: [], players: [], matches: [], events: [] };
let currentMatchId = null;
let selectedCategoryId = null;
let toastTimer;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, '');
    else if (value !== false && value != null) node.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function toast(message) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add('show');
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2800);
}

function playerName(playerId) {
  return model.players.find((p) => p.playerId === playerId)?.name ?? playerId;
}

function bankById(bankId) { return model.banks.find((b) => b.bankId === bankId); }
function matchById(matchId) { return model.matches.find((m) => m.matchId === matchId); }
function questionByKey(questionKey) { return model.questions.find((q) => q.questionKey === questionKey); }
function eventsForMatch(matchId) { return model.events.filter((e) => e.matchId === matchId); }

async function loadModel() {
  [model.banks, model.questions, model.players, model.matches, model.events] = await Promise.all([
    db.getAll('banks'), db.getAll('questions'), db.getAll('players'), db.getAll('matches'), db.getAll('events')
  ]);
  model.matches.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  model.events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  if (!currentMatchId || !matchById(currentMatchId)) currentMatchId = model.matches[0]?.matchId ?? null;
}

async function refresh() {
  await loadModel();
  renderMatchPicker();
  await renderGame();
  renderBanks();
  renderStats();
}

function switchView(view) {
  els.tabs.forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  els.views.forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
}

function renderMatchPicker() {
  els.matchPicker.replaceChildren();
  if (!model.matches.length) {
    els.matchPicker.append(el('option', { text: 'Sin partidas', value: '' }));
    els.matchPicker.disabled = true;
    return;
  }
  els.matchPicker.disabled = false;
  for (const m of model.matches) {
    const opt = el('option', { value: m.matchId, text: `${m.name} · ${m.status === 'closed' ? 'cerrada' : 'abierta'}` });
    if (m.matchId === currentMatchId) opt.selected = true;
    els.matchPicker.append(opt);
  }
}

async function appendEvent(matchId, type, payload = {}) {
  const matchEvents = await db.eventsForMatch(matchId);
  const seq = Math.max(0, ...matchEvents.map((e) => e.seq ?? 0)) + 1;
  const event = makeEvent(matchId, seq, type, payload);
  await db.put('events', event);
  return event;
}

async function renderGame() {
  els.gameRoot.replaceChildren();
  if (!model.matches.length) {
    els.gameRoot.append(el('div', { class: 'empty', text: 'Carga un banco y crea una partida para empezar.' }));
    return;
  }
  const match = matchById(currentMatchId);
  if (!match) return;
  const bank = bankById(match.bankId);
  const matchEvents = eventsForMatch(match.matchId);
  const state = deriveMatchState(match, matchEvents);
  const bankQuestions = model.questions.filter((q) => q.bankId === match.bankId);
  const enabledCategories = (bank?.categories ?? []).filter((c) => match.enabledCategoryIds.includes(c.categoryId));
  const playerIds = match.playerIds ?? [];

  const top = el('div', { class: 'grid two' });
  const board = el('div', { class: 'card' });
  const side = el('div', { class: 'card' });

  board.append(el('p', { class: 'eyebrow', text: state.status === 'closed' ? 'PARTIDA CERRADA' : 'TURNO ACTUAL' }));
  const playerStrip = el('div', { class: 'player-strip' });
  for (const pid of playerIds) {
    const qs = state.quesitosByPlayer.get(pid) ?? new Set();
    const btn = el('button', {
      class: `player-button${pid === state.currentPlayerId ? ' active' : ''}`,
      text: `${playerName(pid)} · ${qs.size} quesito${qs.size === 1 ? '' : 's'}`,
      disabled: Boolean(state.currentDraw) || state.status === 'closed',
      onclick: async () => {
        if (pid === state.currentPlayerId) return;
        await appendEvent(match.matchId, EVENT_TYPES.TURN_SET, { playerId: pid });
        await refresh();
      }
    });
    playerStrip.append(btn);
  }
  board.append(playerStrip);

  if (state.status === 'closed') {
    board.append(el('h3', { text: 'Partida finalizada' }));
    board.append(el('p', { class: 'muted', text: 'Puedes consultar las estadísticas o deshacer el cierre desde el historial.' }));
  } else if (state.currentDraw) {
    renderCurrentQuestion(board, match, bank, state, bankQuestions);
  } else {
    renderQuestionPicker(board, match, bank, state, bankQuestions, enabledCategories);
  }

  side.append(el('p', { class: 'eyebrow', text: 'QUESITOS' }));
  const qGrid = el('div', { class: 'grid' });
  for (const pid of playerIds) {
    const set = state.quesitosByPlayer.get(pid) ?? new Set();
    const row = el('div');
    row.append(el('strong', { text: playerName(pid) }));
    const badges = el('div', { class: 'badges' });
    for (const category of enabledCategories) {
      badges.append(el('span', { class: 'badge', text: `${set.has(category.categoryId) ? '●' : '○'} ${category.label}` }));
    }
    row.append(badges);
    qGrid.append(row);
  }
  side.append(qGrid);

  side.append(el('hr'));
  side.append(el('p', { class: 'eyebrow', text: 'CONTROL' }));
  const controls = el('div', { class: 'toolbar' });
  controls.append(el('button', { text: 'Deshacer', disabled: !canUndo(matchEvents), onclick: () => undoLast(match) }));
  controls.append(el('button', { text: 'Rehacer', disabled: !canRedo(matchEvents), onclick: () => redoLast(match) }));
  if (state.status !== 'closed') {
    controls.append(el('button', { class: 'danger', text: 'Cerrar partida', onclick: () => closeMatch(match) }));
  }
  side.append(controls);

  side.append(el('hr'));
  side.append(el('p', { class: 'eyebrow', text: 'HISTORIAL' }));
  side.append(renderTimeline(matchEvents));

  top.append(board, side);
  els.gameRoot.append(top);
}

function renderQuestionPicker(root, match, bank, state, questions, categories) {
  root.append(el('h3', { text: `Juega ${playerName(state.currentPlayerId)}` }));
  root.append(el('p', { class: 'muted', text: 'Elige la categoría indicada por el tablero y saca la siguiente pregunta elegible.' }));

  if (!selectedCategoryId || !match.enabledCategoryIds.includes(selectedCategoryId)) selectedCategoryId = categories[0]?.categoryId ?? null;
  const grid = el('div', { class: 'category-grid' });
  for (const category of categories) {
    const used = state.usedQuestionKeys;
    const count = questions.filter((q) => q.status === 'active' && q.categoryIds.includes(category.categoryId) && match.enabledLevelKeys.includes(q.levelKey) && !used.has(q.questionKey)).length;
    grid.append(el('button', {
      class: `category-button${selectedCategoryId === category.categoryId ? ' active' : ''}`,
      text: `${category.label} · ${count}`,
      onclick: async () => { selectedCategoryId = category.categoryId; await renderGame(); }
    }));
  }
  root.append(grid);

  const alreadyHas = (state.quesitosByPlayer.get(state.currentPlayerId) ?? new Set()).has(selectedCategoryId);
  const quesitoLabel = el('label', { class: 'badge' });
  const quesitoInput = el('input', { type: 'checkbox', id: 'quesito-toggle' });
  quesitoInput.style.width = 'auto';
  quesitoInput.disabled = alreadyHas;
  quesitoLabel.append(quesitoInput, document.createTextNode(alreadyHas ? ' Quesito ya obtenido' : ' Esta pregunta es de quesito'));
  root.append(quesitoLabel);

  const draw = el('button', {
    class: 'primary',
    text: 'Sacar pregunta',
    disabled: !selectedCategoryId,
    onclick: async () => {
      const question = selectNextQuestion({
        questions,
        categoryId: selectedCategoryId,
        enabledLevelKeys: match.enabledLevelKeys,
        usedQuestionKeys: state.usedQuestionKeys,
      });
      if (!question) { toast('No quedan preguntas elegibles en esa categoría.'); return; }
      await appendEvent(match.matchId, EVENT_TYPES.QUESTION_DRAWN, {
        questionKey: question.questionKey,
        playerId: state.currentPlayerId,
        categoryId: selectedCategoryId,
        levelKey: question.levelKey,
        quesitoAttempt: Boolean(quesitoInput.checked),
      });
      await refresh();
    }
  });
  root.append(el('div', { class: 'toolbar' }, [draw]));
}

function renderCurrentQuestion(root, match, bank, state) {
  const draw = state.currentDraw;
  const question = questionByKey(draw.questionKey);
  if (!question) {
    root.append(el('p', { class: 'warning', text: 'La pregunta de este evento no existe en el banco local.' }));
    return;
  }
  const category = bank?.categories?.find((c) => c.categoryId === draw.categoryId);
  const level = bank?.levels?.find((l) => l.levelKey === draw.levelKey);
  root.append(el('div', { class: 'badges' }, [
    el('span', { class: 'badge', text: category?.label ?? draw.categoryId }),
    el('span', { class: 'badge', text: level?.label ?? draw.levelKey }),
    draw.quesitoAttempt ? el('span', { class: 'badge', text: 'Quesito' }) : null,
  ]));
  root.append(el('div', { class: 'question-card' }, [
    el('div', { class: 'question-text', text: question.prompt }),
    el('div', { class: `answer-box${state.answerRevealed ? '' : ' hidden'}` }, [
      el('strong', { text: 'Respuesta: ' }), document.createTextNode(question.answer),
      question.explanation ? el('p', { class: 'muted', text: question.explanation }) : null,
    ])
  ]));

  const toolbar = el('div', { class: 'toolbar' });
  if (!state.answerRevealed) {
    toolbar.append(el('button', { text: 'Mostrar respuesta', onclick: async () => {
      await appendEvent(match.matchId, EVENT_TYPES.ANSWER_REVEALED, { drawEventId: draw.eventId, questionKey: draw.questionKey });
      await refresh();
    }}));
  }
  toolbar.append(el('button', { class: 'good', text: 'Acierto', onclick: () => recordResult(match, state, true) }));
  toolbar.append(el('button', { class: 'danger', text: 'Fallo', onclick: () => recordResult(match, state, false) }));
  toolbar.append(el('button', { text: 'Descartar / contaminada', onclick: () => exposeQuestion(match, state, question) }));
  root.append(toolbar);
}

async function recordResult(match, state, correct) {
  const draw = state.currentDraw;
  if (!draw) return;
  const currentQuesitos = state.quesitosByPlayer.get(draw.playerId) ?? new Set();
  const quesitoWon = Boolean(correct && draw.quesitoAttempt && !currentQuesitos.has(draw.categoryId));
  const notes = prompt('Ayudas o incidencias (opcional):', '') ?? '';
  await appendEvent(match.matchId, EVENT_TYPES.RESULT_RECORDED, {
    drawEventId: draw.eventId,
    questionKey: draw.questionKey,
    playerId: draw.playerId,
    categoryId: draw.categoryId,
    levelKey: draw.levelKey,
    correct,
    quesitoAttempt: Boolean(draw.quesitoAttempt),
    quesitoWon,
    notes,
  });
  await refresh();
}

async function exposeQuestion(match, state, question) {
  const reason = prompt('Motivo del descarte/contaminación:', 'Expuesta por error') ?? 'Expuesta por error';
  const previousStatus = question.status;
  await db.put('questions', { ...question, status: 'discarded', discardReason: reason, discardedAt: new Date().toISOString() });
  await appendEvent(match.matchId, EVENT_TYPES.QUESTION_EXPOSED, {
    drawEventId: state.currentDraw?.eventId ?? null,
    questionKey: question.questionKey,
    playerId: state.currentDraw?.playerId ?? state.currentPlayerId,
    reason,
    previousStatus,
    globalDiscard: true,
  });
  await refresh();
}

function reversible(event) {
  return [EVENT_TYPES.TURN_SET, EVENT_TYPES.QUESTION_DRAWN, EVENT_TYPES.ANSWER_REVEALED, EVENT_TYPES.RESULT_RECORDED, EVENT_TYPES.QUESTION_EXPOSED, EVENT_TYPES.MATCH_CLOSED].includes(event.type);
}
function canUndo(events) { return getActiveEvents(events).some(reversible); }
function canRedo(events) { return getRevertedEventIds(events).size > 0; }

async function undoLast(match) {
  const events = await db.eventsForMatch(match.matchId);
  const active = getActiveEvents(events).filter(reversible);
  const target = active.at(-1);
  if (!target) return;
  if (target.type === EVENT_TYPES.QUESTION_EXPOSED) {
    const q = await db.get('questions', target.payload.questionKey);
    if (q) await db.put('questions', { ...q, status: target.payload.previousStatus ?? 'active', discardReason: null, discardedAt: null });
  }
  if (target.type === EVENT_TYPES.MATCH_CLOSED) await db.put('matches', { ...match, status: 'open', closedAt: null });
  await appendEvent(match.matchId, EVENT_TYPES.EVENT_REVERTED, { targetEventId: target.eventId });
  await refresh();
}

async function redoLast(match) {
  const events = await db.eventsForMatch(match.matchId);
  const reverted = getRevertedEventIds(events);
  const candidates = events.filter((e) => reverted.has(e.eventId) && reversible(e)).sort((a,b) => (a.seq ?? 0) - (b.seq ?? 0));
  const target = candidates.at(-1);
  if (!target) return;
  if (target.type === EVENT_TYPES.QUESTION_EXPOSED) {
    const q = await db.get('questions', target.payload.questionKey);
    if (q) await db.put('questions', { ...q, status: 'discarded', discardReason: target.payload.reason, discardedAt: new Date().toISOString() });
  }
  if (target.type === EVENT_TYPES.MATCH_CLOSED) await db.put('matches', { ...match, status: 'closed', closedAt: new Date().toISOString() });
  await appendEvent(match.matchId, EVENT_TYPES.EVENT_RESTORED, { targetEventId: target.eventId });
  await refresh();
}

async function closeMatch(match) {
  const reason = prompt('Motivo de cierre:', 'Tiempo límite') ?? 'Cierre manual';
  await appendEvent(match.matchId, EVENT_TYPES.MATCH_CLOSED, { reason });
  await db.put('matches', { ...match, status: 'closed', closedAt: new Date().toISOString(), closeReason: reason });
  await refresh();
}

function renderTimeline(events) {
  const wrap = el('div', { class: 'timeline' });
  const reverted = getRevertedEventIds(events);
  const visible = [...events].sort((a,b) => (b.seq ?? 0) - (a.seq ?? 0)).slice(0, 60);
  for (const event of visible) {
    const label = describeEvent(event);
    const item = el('div', { class: 'timeline-item' });
    item.append(el('span', { class: 'timeline-seq', text: `#${event.seq}` }));
    const text = el('span', { text: label });
    if (reverted.has(event.eventId)) { text.style.textDecoration = 'line-through'; text.style.opacity = '.55'; }
    item.append(text);
    wrap.append(item);
  }
  if (!visible.length) wrap.append(el('p', { class: 'muted', text: 'Sin eventos todavía.' }));
  return wrap;
}

function describeEvent(event) {
  const p = event.payload ?? {};
  switch (event.type) {
    case EVENT_TYPES.MATCH_CREATED: return 'Partida creada';
    case EVENT_TYPES.TURN_SET: return `Turno → ${playerName(p.playerId)}`;
    case EVENT_TYPES.QUESTION_DRAWN: return `Pregunta ${p.questionKey} → ${playerName(p.playerId)}${p.quesitoAttempt ? ' · quesito' : ''}`;
    case EVENT_TYPES.ANSWER_REVEALED: return 'Respuesta mostrada';
    case EVENT_TYPES.RESULT_RECORDED: return `${playerName(p.playerId)} · ${p.correct ? 'acierto' : 'fallo'}${p.quesitoWon ? ' · quesito ganado' : ''}`;
    case EVENT_TYPES.QUESTION_EXPOSED: return `Pregunta descartada/contaminada · ${p.reason ?? ''}`;
    case EVENT_TYPES.MATCH_CLOSED: return `Partida cerrada · ${p.reason ?? ''}`;
    case EVENT_TYPES.EVENT_REVERTED: return `Deshacer evento ${p.targetEventId?.slice(-8) ?? ''}`;
    case EVENT_TYPES.EVENT_RESTORED: return `Rehacer evento ${p.targetEventId?.slice(-8) ?? ''}`;
    default: return event.type;
  }
}

function renderBanks() {
  els.banksRoot.replaceChildren();
  if (!model.banks.length) {
    els.banksRoot.append(el('div', { class: 'empty', text: 'No hay bancos cargados. Exporta la hoja Banco como CSV e impórtala aquí.' }));
    return;
  }
  const list = el('div', { class: 'bank-list' });
  for (const bank of model.banks) {
    const qs = model.questions.filter((q) => q.bankId === bank.bankId);
    const active = qs.filter((q) => q.status === 'active').length;
    const retired = qs.filter((q) => q.status === 'retired').length;
    const discarded = qs.filter((q) => q.status === 'discarded').length;
    const card = el('div', { class: 'card' });
    const row = el('div', { class: 'bank-row' });
    row.append(el('div', {}, [
      el('h3', { text: bank.name }),
      el('p', { class: 'muted', text: `${qs.length} preguntas · ${active} activas · ${retired} ya administradas · ${discarded} descartadas` }),
      el('div', { class: 'badges' }, [
        ...(bank.categories ?? []).map((c) => el('span', { class: 'badge', text: c.label })),
        ...(bank.levels ?? []).map((l) => el('span', { class: 'badge', text: l.label })),
      ])
    ]));
    const actions = el('div', { class: 'actions' });
    actions.append(el('button', { text: 'Administrar estados', onclick: () => toggleQuestionAdmin(card, bank, qs) }));
    row.append(actions);
    card.append(row);
    list.append(card);
  }
  els.banksRoot.append(list);
}

function toggleQuestionAdmin(card, bank, questions) {
  const existing = card.querySelector('.question-admin');
  if (existing) { existing.remove(); return; }
  const box = el('div', { class: 'question-admin' });
  const table = el('table');
  table.append(el('thead', {}, el('tr', {}, [el('th',{text:'ID'}),el('th',{text:'Categoría'}),el('th',{text:'Nivel'}),el('th',{text:'Estado'}),el('th',{text:'Acción'})])));
  const tbody = el('tbody');
  for (const q of [...questions].sort((a,b) => String(a.questionId).localeCompare(String(b.questionId)))) {
    const cat = bank.categories?.find((c) => c.categoryId === q.categoryIds?.[0])?.label ?? q.categoryIds?.[0] ?? '';
    const lvl = bank.levels?.find((l) => l.levelKey === q.levelKey)?.label ?? q.levelKey;
    const action = el('button', { text: q.status === 'active' ? 'Descartar' : 'Reactivar', onclick: async () => {
      const nextStatus = q.status === 'active' ? 'discarded' : 'active';
      await db.put('questions', { ...q, status: nextStatus, discardReason: nextStatus === 'discarded' ? 'Descarte manual' : null });
      await refresh();
      toast(`Pregunta ${q.questionId}: ${nextStatus}`);
    }});
    tbody.append(el('tr', {}, [el('td',{text:q.questionId}),el('td',{text:cat}),el('td',{text:lvl}),el('td',{text:q.status}),el('td',{},action)]));
  }
  table.append(tbody); box.append(table); card.append(box);
}

function renderStats() {
  els.statsRoot.replaceChildren();
  if (!model.events.length) {
    els.statsRoot.append(el('div', { class: 'empty', text: 'Las estadísticas aparecerán en cuanto haya resultados registrados.' }));
    return;
  }
  const stats = computeStats(model.matches, model.events);
  const wins = aggregateMatches(model.matches, model.events, getActiveEvents);
  const grid = el('div', { class: 'grid three' });
  for (const row of stats.byPlayer) {
    const card = el('div', { class: 'card' });
    card.append(el('p', { class: 'eyebrow', text: playerName(row.playerId) }));
    card.append(el('div', { class: 'kpi', text: pct(row.precision) }));
    card.append(el('p', { class: 'muted', text: `${row.correct}/${row.resolved} aciertos · ${row.quesitosWon} quesitos · ${wins.get(row.playerId) ?? 0} victorias/empates al cierre` }));
    card.append(el('div', { class: 'progress' }, el('span')));
    card.querySelector('.progress span').style.width = `${Math.max(0, Math.min(100, row.precision * 100))}%`;
    grid.append(card);
  }
  els.statsRoot.append(grid);

  const byCat = el('div', { class: 'card' });
  byCat.style.marginTop = '1rem';
  byCat.append(el('h3', { text: 'Por jugador y categoría' }));
  const table = el('table');
  table.append(el('thead', {}, el('tr', {}, [el('th',{text:'Jugador'}),el('th',{text:'Categoría'}),el('th',{text:'Resueltos'}),el('th',{text:'Aciertos'}),el('th',{text:'Precisión'}),el('th',{text:'Quesitos'})])));
  const tbody = el('tbody');
  for (const r of stats.byPlayerCategory.sort((a,b) => playerName(a.playerId).localeCompare(playerName(b.playerId)) || a.categoryId.localeCompare(b.categoryId))) {
    const category = model.banks.flatMap((b) => b.categories ?? []).find((c) => c.categoryId === r.categoryId)?.label ?? r.categoryId;
    tbody.append(el('tr', {}, [el('td',{text:playerName(r.playerId)}),el('td',{text:category}),el('td',{text:r.resolved}),el('td',{text:r.correct}),el('td',{text:pct(r.precision)}),el('td',{text:r.quesitosWon})]));
  }
  table.append(tbody); byCat.append(table); els.statsRoot.append(byCat);

  const byLvl = el('div', { class: 'card' });
  byLvl.style.marginTop = '1rem';
  byLvl.append(el('h3', { text: 'Por jugador y nivel' }));
  const table2 = el('table');
  table2.append(el('thead', {}, el('tr', {}, [el('th',{text:'Jugador'}),el('th',{text:'Nivel'}),el('th',{text:'Resueltos'}),el('th',{text:'Aciertos'}),el('th',{text:'Precisión'})])));
  const tbody2 = el('tbody');
  for (const r of stats.byPlayerLevel.sort((a,b) => playerName(a.playerId).localeCompare(playerName(b.playerId)) || a.levelKey.localeCompare(b.levelKey))) {
    const level = model.banks.flatMap((b) => b.levels ?? []).find((l) => l.levelKey === r.levelKey)?.label ?? r.levelKey;
    tbody2.append(el('tr', {}, [el('td',{text:playerName(r.playerId)}),el('td',{text:level}),el('td',{text:r.resolved}),el('td',{text:r.correct}),el('td',{text:pct(r.precision)})]));
  }
  table2.append(tbody2); byLvl.append(table2); els.statsRoot.append(byLvl);
}

async function openNewMatchDialog() {
  if (!model.banks.length) { switchView('banks'); toast('Primero importa un banco de preguntas.'); return; }
  els.newMatchBank.replaceChildren(...model.banks.map((b) => el('option', { value: b.bankId, text: b.name })));
  renderNewMatchOptions();
  els.newMatchDialog.showModal();
}

function renderNewMatchOptions() {
  const bank = bankById(els.newMatchBank.value) ?? model.banks[0];
  els.newMatchCategories.replaceChildren();
  els.newMatchLevels.replaceChildren();
  for (const c of bank?.categories ?? []) {
    const input = el('input', { type: 'checkbox', name: 'category', value: c.categoryId, checked: true });
    input.checked = true;
    els.newMatchCategories.append(el('label', {}, [input, document.createTextNode(c.label)]));
  }
  for (const l of bank?.levels ?? []) {
    const input = el('input', { type: 'checkbox', name: 'level', value: l.levelKey, checked: true });
    input.checked = true;
    els.newMatchLevels.append(el('label', {}, [input, document.createTextNode(l.label)]));
  }
}

async function createMatchFromForm(event) {
  event.preventDefault();
  const fd = new FormData(els.newMatchForm);
  const bankId = fd.get('bankId');
  const names = String(fd.get('players') ?? '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (names.length < 1) { toast('Añade al menos un jugador.'); return; }
  const bank = bankById(bankId);
  const enabledCategoryIds = [...els.newMatchCategories.querySelectorAll('input:checked')].map((i) => i.value);
  const enabledLevelKeys = [...els.newMatchLevels.querySelectorAll('input:checked')].map((i) => i.value);
  if (!enabledCategoryIds.length || !enabledLevelKeys.length) { toast('Selecciona al menos una categoría y un nivel.'); return; }

  const playerIds = [];
  for (const name of names) {
    let player = model.players.find((p) => p.name.trim().toLowerCase() === name.toLowerCase());
    if (!player) {
      player = { playerId: makeId('player'), name, createdAt: new Date().toISOString() };
      await db.put('players', player);
      model.players.push(player);
    }
    playerIds.push(player.playerId);
  }
  const matchId = makeId('match');
  const match = {
    matchId,
    name: String(fd.get('name') ?? 'Nueva partida').trim() || 'Nueva partida',
    bankId,
    playerIds,
    enabledCategoryIds,
    enabledLevelKeys,
    status: 'open',
    createdAt: new Date().toISOString(),
    configVersion: 1,
  };
  await db.put('matches', match);
  await db.put('events', makeEvent(matchId, 1, EVENT_TYPES.MATCH_CREATED, { playerIds, bankId, enabledCategoryIds, enabledLevelKeys }));
  currentMatchId = matchId;
  selectedCategoryId = bank?.categories?.find((c) => enabledCategoryIds.includes(c.categoryId))?.categoryId ?? null;
  els.newMatchDialog.close();
  els.newMatchForm.reset();
  await refresh();
  switchView('game');
}

async function importBankFile(file) {
  const text = await file.text();
  const { bank, questions } = importBankFromCsv(text, file.name.replace(/\.csv$/i, ''));
  await db.put('banks', bank);
  await db.putMany('questions', questions);
  await refresh();
  toast(`Banco importado: ${questions.length} preguntas.`);
}

async function exportBackup() {
  const payload = await db.exportAll();
  const stamp = new Date().toISOString().slice(0,10);
  downloadJson(`trivial-backup-${stamp}.json`, payload);
}

async function importBackup(file) {
  const payload = JSON.parse(await file.text());
  const replace = confirm('¿Reemplazar todos los datos locales? Aceptar = reemplazar; Cancelar = fusionar.');
  await db.importAll(payload, { replace });
  currentMatchId = null;
  await refresh();
  toast('Copia importada.');
}

els.tabs.forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
els.matchPicker.addEventListener('change', async () => { currentMatchId = els.matchPicker.value || null; selectedCategoryId = null; await renderGame(); });
els.newMatchBtn.addEventListener('click', openNewMatchDialog);
els.newMatchBank.addEventListener('change', renderNewMatchOptions);
els.closeMatchDialog.addEventListener('click', () => els.newMatchDialog.close());
els.cancelMatch.addEventListener('click', () => els.newMatchDialog.close());
els.newMatchForm.addEventListener('submit', createMatchFromForm);
els.bankFile.addEventListener('change', async () => { if (els.bankFile.files?.[0]) await importBankFile(els.bankFile.files[0]); els.bankFile.value = ''; });
els.exportBackup.addEventListener('click', exportBackup);
els.importBackup.addEventListener('change', async () => { if (els.importBackup.files?.[0]) await importBackup(els.importBackup.files[0]); els.importBackup.value = ''; });

window.addEventListener('error', (e) => { console.error(e.error ?? e.message); toast('Se produjo un error. Revisa la consola del navegador.'); });

await db.init();
await refresh();
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(console.warn);
