// Kuess: one store, one render, and a named action for every button.
//
//   tap  ->  action  ->  database function  ->  room.version bumps
//   every device hears the bump  ->  re-reads its state  ->  render()

import { view } from './views.js';
import { t, setLang } from './i18n.js';
import { api, signIn, watchRoom, configured } from './api.js';

const root = document.getElementById('app');
const toastShelf = document.getElementById('toasts');

const store = {
  name: localStorage.getItem('kuess:name') || '',
  code: '',
  joinOpen: false,
  game: null,      // what kuess_state returned: { me, room, players }
  sheet: null,     // { type: 'settings' | 'confirm' | 'kuess', ... }
  result: null,    // your own kuess result, shown big for a moment
  guess: '',
  memo: '',
  busy: false,
};

let roomId = null;
let stopWatching = null;
let seenEvent = null;
let lastStatus = null;
let lastTurn = null;
let resultTimer = null;

const ready = configured ? signIn() : Promise.reject(new Error('setup'));
ready.catch(() => {});

const me = () => store.game?.players.find((p) => p.id === store.game.me);

// ------------------------------------------------------------------ render

let entered = new Set();

function render() {
  // Keep typing undisturbed when a live update redraws the page.
  const a = document.activeElement;
  const keep = a?.id && /^(INPUT|TEXTAREA)$/.test(a.tagName)
    ? { id: a.id, value: a.value, start: a.selectionStart, end: a.selectionEnd, scroll: a.scrollTop }
    : null;

  root.innerHTML = view(store);

  // Things marked data-enter animate only the first time they appear.
  const present = new Set();
  let autofocus = null;
  root.querySelectorAll('[data-enter]').forEach((el) => {
    const key = el.dataset.enter;
    present.add(key);
    if (!entered.has(key)) {
      el.classList.add('enter');
      autofocus ??= el.matches('[data-autofocus]') ? el : el.querySelector('[data-autofocus]');
    }
  });
  entered = present;

  if (autofocus) {
    autofocus.focus({ preventScroll: true });
  } else if (keep) {
    const el = document.getElementById(keep.id);
    if (el) {
      el.value = keep.value;
      el.focus({ preventScroll: true });
      try { el.setSelectionRange(keep.start, keep.end); } catch { /* not a text field */ }
      el.scrollTop = keep.scroll;
    }
  }
}

// ------------------------------------------------------------------ feedback

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  toastShelf.append(el);
  setTimeout(() => el.classList.add('leaving'), 2600);
  setTimeout(() => el.remove(), 3000);
}

function fail(error) {
  const code = String(error?.message || '');
  if (/fetch|network|load failed/i.test(code)) return toast(t('err_network'), 'bad');
  const key = `err_${code}`;
  const known = t(key) !== key;
  if (!known) console.error(error);
  toast(known ? t(key) : t('err_generic'), 'bad');
}

const EVENT_TEXT = {
  joined: 'ev_joined', left: 'ev_left', start: 'ev_start', pass: 'ev_pass',
  wrong: 'ev_wrong', correct: 'ev_correct', out: 'ev_out', ended: 'ev_ended', rematch: 'ev_rematch',
};

function announce(ev) {
  if (EVENT_TEXT[ev.type]) toast(t(EVENT_TEXT[ev.type], { name: ev.name, value: ev.value }));
}

// Runs an action with a busy guard, so a double tap does not do it twice.
async function run(fn) {
  if (store.busy) return;
  store.busy = true;
  render();
  try {
    await ready;
    await fn();
  } catch (error) {
    fail(error);
  } finally {
    store.busy = false;
    render();
  }
}

// ------------------------------------------------------------------ room sync

const memoKey = () => `kuess:memo:${roomId}`;
const saveMemo = () => roomId && localStorage.setItem(memoKey(), store.memo);

async function enterRoom(id) {
  if (roomId !== id) {
    stopWatching?.();
    roomId = id;
    seenEvent = lastStatus = lastTurn = null;
    store.memo = localStorage.getItem(memoKey()) || '';
    stopWatching = watchRoom(id, refresh);
  }
  store.joinOpen = false;
  await refresh();
}

function exitRoom(message) {
  stopWatching?.();
  stopWatching = null;
  roomId = null;
  Object.assign(store, { game: null, sheet: null, result: null, joinOpen: false });
  render();
  if (message) toast(message);
}

// Re-reads the room. Calls that arrive mid-flight are folded into one more read.
let inflight = null;
let again = false;

function refresh() {
  if (!roomId) return Promise.resolve();
  if (inflight) { again = true; return inflight; }
  const id = roomId;
  inflight = (async () => {
    try {
      const state = await api.state(id);
      if (id === roomId) apply(state);
    } catch (error) {
      if (/not_in_room/.test(error.message)) exitRoom();
      else console.warn(error);
    } finally {
      inflight = null;
      if (again) { again = false; refresh(); }
    }
  })();
  return inflight;
}

function apply(state) {
  const { status } = state.room;

  if (status === 'closed' || status === 'left') {
    const wasHost = me()?.is_host;
    return exitRoom(status === 'closed' && !wasHost ? t('ev_closed') : null);
  }

  const ev = state.room.last_event;
  if (ev && seenEvent !== null && ev.id > seenEvent && ev.player !== state.me) announce(ev);
  seenEvent = ev?.id ?? 0;

  if (lastStatus === 'lobby' && status === 'playing') {
    store.memo = '';            // a new game gets a clean memo
    saveMemo();
  }
  if (status === 'playing' && state.room.turn_player === state.me && lastTurn !== state.me) {
    navigator.vibrate?.(30);    // a little tap on the table: your turn
  }
  lastStatus = status;
  lastTurn = state.room.turn_player;

  store.game = state;
  if (store.sheet?.type === 'kuess' && state.room.turn_player !== state.me) store.sheet = null;
  if (store.sheet?.phase && store.sheet.phase !== status) store.sheet = null;
  render();
}

// Host settings feel instant: update locally, then let the database confirm.
function changeSetting(patch) {
  Object.assign(store.game.room, patch);
  render();
  api.settings(roomId, patch).catch((error) => { fail(error); refresh(); });
}

function confirmSheet(textKey, labelKey, act) {
  store.sheet = { type: 'confirm', text: t(textKey), label: t(labelKey), act, phase: store.game?.room.status };
  render();
}

// ------------------------------------------------------------------ actions

const actions = {
  // 1st page
  openJoin() { store.joinOpen = true; render(); document.getElementById('code')?.focus(); },
  closeJoin() { store.joinOpen = false; render(); },

  newGame: () => run(async () => {
    if (!store.name.trim()) throw new Error('need_name');
    await enterRoom(await api.createRoom(store.name));
  }),

  join: () => run(async () => {
    if (!store.name.trim()) throw new Error('need_name');
    if (!/^\d{5}$/.test(store.code)) throw new Error('bad_code');
    const id = await api.joinRoom(store.code, store.name);
    store.code = '';
    await enterRoom(id);
  }),

  // 2nd page
  copyCode() {
    navigator.clipboard?.writeText(store.game.room.code).then(() => toast(t('copied')), () => {});
  },
  setMode:    (d) => changeSetting({ number_mode: d.value }),
  setRange:   (d) => changeSetting({ number_max: Number(d.value) }),
  setChances: (d) => changeSetting({ max_kuess: d.value ? Number(d.value) : null }),
  setMemo:    (d) => changeSetting({ memo: d.value === 'true' }),

  move(d) {
    const players = store.game.players;
    const i = players.findIndex((p) => p.id === d.id);
    const j = i + Number(d.dir);
    if (i < 0 || j < 0 || j >= players.length) return;
    [players[i], players[j]] = [players[j], players[i]];
    render();
    api.setOrder(roomId, players.map((p) => p.id)).catch((error) => { fail(error); refresh(); });
  },

  setNumber(d, el) {
    const raw = el.value.trim();
    const value = raw === '' ? null : Number(raw);
    const player = store.game.players.find((p) => p.id === d.id);
    if (player) player.number = value;
    api.setNumber(roomId, d.id, value).catch((error) => { fail(error); refresh(); });
  },

  start: () => run(() => api.start(roomId)),

  // 3rd page
  pass: () => run(() => api.pass(roomId)),

  openKuess() { store.sheet = { type: 'kuess' }; store.guess = ''; render(); },

  kuess() {
    if (!/^\d+$/.test(store.guess)) return fail(new Error('bad_number'));
    const value = Number(store.guess);
    const max = store.game.room.max_kuess;
    const used = me().kuess_used + 1;
    return run(async () => {
      const outcome = await api.guess(roomId, value);
      store.sheet = null;
      store.result = { type: outcome, value, left: max ? max - used : null, at: Date.now() };
      refresh();
      navigator.vibrate?.(outcome === 'correct' ? [40, 60, 40] : 120);
      clearTimeout(resultTimer);
      resultTimer = setTimeout(actions.dismissResult, outcome === 'wrong' ? 1700 : 2600);
    });
  },

  dismissResult() { clearTimeout(resultTimer); store.result = null; render(); },

  askEnd() { confirmSheet('confirm_end', 'end_game', 'end'); },
  end: () => run(async () => { store.sheet = null; await api.end(roomId); }),

  // summary
  rematch: () => run(() => api.rematch(roomId)),

  // any page
  askLeave() {
    const host = me()?.is_host;
    confirmSheet(host ? 'confirm_leave_host' : 'confirm_leave', host ? 'close_room' : 'leave', 'leave');
  },
  leave: () => run(async () => {
    store.sheet = null;
    const id = roomId;
    exitRoom();
    await api.leave(id);
  }),

  openSettings() { store.sheet = { type: 'settings' }; render(); },
  closeSheet() { store.sheet = null; render(); },
  setLang(d) {
    setLang(d.value);
    if (store.sheet?.type === 'confirm') store.sheet = null;
    render();
  },
};

// ------------------------------------------------------------------ wiring

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const action = actions[el.dataset.act];
  if (action) { e.preventDefault(); action(el.dataset, el); }
});

document.addEventListener('submit', (e) => {
  e.preventDefault();
  actions[e.target.dataset.submit]?.();
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.inputMode === 'numeric') {
    const digits = el.value.replace(/\D/g, '');
    if (digits !== el.value) el.value = digits;
  }
  const key = el.dataset.input;
  if (!key) return;
  store[key] = el.value;
  if (key === 'name') localStorage.setItem('kuess:name', el.value);
  if (key === 'memo') saveMemo();
});

document.addEventListener('change', (e) => {
  const action = actions[e.target.dataset.change];
  if (action) action(e.target.dataset, e.target);
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (store.result) actions.dismissResult();
  else if (store.sheet) actions.closeSheet();
});

// Phones sleep and drop sockets; catch up whenever the page comes back.
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.addEventListener('online', () => refresh());
setInterval(() => { if (!document.hidden) refresh(); }, 15000);

async function boot() {
  render();
  if (!configured) return toast(t('err_setup'), 'bad');
  try {
    await ready;
    const id = await api.myRoom();      // came back after a refresh? sit back down
    if (id) await enterRoom(id);
  } catch (error) {
    fail(error);
  }
}

boot();
