// Views are pure: they read the store and return HTML. No side effects.
// Buttons say what they do through data-act; app.js holds the matching actions.

import { t, LANGS, getLang } from './i18n.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmt = (n) => Number(n).toLocaleString('en-US');
const STATUS = { waiting: '⏳', solved: '✅', out: '❌' };

// ---------------------------------------------------------------- pieces

// A playing card. No number means you are looking at its back.
function card({ name, number, status, size = 'sm', corner = '' }) {
  const hidden = number === null || number === undefined;
  const digits = hidden ? 0 : String(number).length;
  return `
    <div class="card ${size} ${hidden ? 'back' : 'face'}" data-digits="${digits}">
      ${name ? `<span class="c-name">${esc(name)}</span>` : ''}
      ${corner || (status ? `<span class="c-corner" aria-label="${status}">${STATUS[status]}</span>` : '')}
      <span class="c-num">${hidden ? '???' : esc(number)}</span>
    </div>`;
}

const seg = (act, options, current) => `
  <div class="seg" role="group">
    ${options.map(([value, label]) => `
      <button type="button" data-act="${act}" data-value="${value}"
        aria-pressed="${String(value) === String(current)}">${label}</button>`).join('')}
  </div>`;

const rangeLabel = (max) => (getLang() === 'ja' ? `1〜${fmt(max)}` : `1–${fmt(max)}`);
const chancesLabel = (max) => (max ? String(max) : '∞');

function topbar(store) {
  const g = store.game;
  const inRoom = g && g.room.status !== 'closed';
  return `
    <header class="bar">
      ${inRoom ? `<span class="bar-mark">Kuess</span><span class="bar-room">${t('room')} ${esc(g.room.code)}</span>` : '<span></span>'}
      <button class="kebab" data-act="openSettings" aria-label="${t('settings')}">⋮</button>
    </header>`;
}

// ---------------------------------------------------------------- 1st page

function home(store) {
  const dis = store.busy ? 'disabled' : '';
  return `
    <section class="home">
      <div class="fan" aria-hidden="true" data-enter="fan">
        <div class="fan-l">${card({ name: 'Mai', number: 7, size: 'md' })}</div>
        <div class="fan-c">${card({ name: t('you'), size: 'md' })}</div>
        <div class="fan-r">${card({ name: 'Ken', number: 42, size: 'md' })}</div>
      </div>
      <h1 class="wordmark">Kuess</h1>
      <p class="tagline">${t('tagline')}</p>

      <form class="entry" data-submit="${store.joinOpen ? 'join' : 'newGame'}" novalidate>
        <label class="field">
          <span>${t('name_label')}</span>
          <input id="name" data-input="name" value="${esc(store.name)}" maxlength="20"
            placeholder="${t('name_ph')}" autocomplete="nickname" enterkeyhint="go">
        </label>
        ${store.joinOpen ? `
          <label class="field">
            <span>${t('room_label')}</span>
            <input id="code" class="code-input" data-input="code" value="${esc(store.code)}"
              inputmode="numeric" pattern="[0-9]*" maxlength="5" placeholder="00000"
              autocomplete="off" enterkeyhint="go" data-autofocus>
          </label>
          <div class="choices">
            <button class="btn primary" type="submit" ${dis}>${t('join')}</button>
            <button class="btn text" type="button" data-act="closeJoin">${t('back')}</button>
          </div>` : `
          <div class="choices two">
            <button class="btn primary tall" type="submit" ${dis}>
              ${t('new_game')}<small>${t('new_game_sub')}</small></button>
            <button class="btn ghost tall" type="button" data-act="openJoin" ${dis}>
              ${t('join_game')}<small>${t('join_sub')}</small></button>
          </div>`}
      </form>
    </section>`;
}

// ---------------------------------------------------------------- 2nd page

function lobby(store) {
  const { room, players, me } = store.game;
  const host = players.find((p) => p.id === me)?.is_host;
  const custom = room.number_mode === 'custom';

  const seats = players.map((p, i) => {
    const mine = p.id === me;
    const tags = [p.is_host && t('host'), mine && t('you')].filter(Boolean)
      .map((x) => `<em class="tag">${x}</em>`).join('');
    let number = '';
    if (custom && host) {
      number = mine
        ? `<span class="own-random" title="${t('own_random')}">🎲</span>`
        : `<input class="num-input" id="num-${p.id}" data-change="setNumber" data-id="${p.id}"
             value="${p.number ?? ''}" inputmode="numeric" pattern="[0-9]*" maxlength="6"
             placeholder="${t('number_ph')}" aria-label="${t('numbers')}: ${esc(p.name)}">`;
    }
    const arrows = host ? `
      <span class="arrows">
        <button type="button" data-act="move" data-id="${p.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Up">↑</button>
        <button type="button" data-act="move" data-id="${p.id}" data-dir="1" ${i === players.length - 1 ? 'disabled' : ''} aria-label="Down">↓</button>
      </span>` : '';
    return `
      <li class="seat ${mine ? 'mine' : ''}">
        <span class="seat-n">${i + 1}</span>
        <span class="seat-name">${esc(p.name)}${tags}</span>
        ${number}${arrows}
      </li>`;
  }).join('');

  const rules = host ? `
    <div class="rules">
      <div class="rule"><span>${t('numbers')}</span>
        ${seg('setMode', [['random', t('random')], ['custom', t('custom')]], room.number_mode)}</div>
      <div class="rule"><span>${custom ? t('range_own') : t('range')}</span>
        ${seg('setRange', [10, 100, 1000].map((n) => [n, rangeLabel(n)]), room.number_max)}</div>
      <div class="rule"><span>${t('chances')}</span>
        ${seg('setChances', [['', '∞'], [1, '1'], [2, '2'], [3, '3'], [5, '5'], [10, '10']], room.max_kuess ?? '')}</div>
      <div class="rule"><span>${t('memo')}</span>
        ${seg('setMemo', [['true', t('on')], ['false', t('off')]], String(room.memo))}</div>
    </div>` : `
    <dl class="rules readonly">
      <div class="rule"><dt>${t('numbers')}</dt><dd>${room.number_mode === 'custom' ? t('custom') : t('random_range', { range: rangeLabel(room.number_max) })}</dd></div>
      <div class="rule"><dt>${t('chances')}</dt><dd>${room.max_kuess ? room.max_kuess : t('unlimited')}</dd></div>
      <div class="rule"><dt>${t('memo')}</dt><dd>${room.memo ? t('on') : t('off')}</dd></div>
    </dl>`;

  const alone = players.length < 2;
  return `
    <section class="lobby">
      <div class="code-block">
        <span class="code-label">${t('room_label')}</span>
        <button type="button" class="code" data-act="copyCode" aria-label="${t('copy')}">
          ${esc(room.code).split('').map((d) => `<span>${d}</span>`).join('')}
        </button>
        <p class="code-hint">${t('tap_copy')}</p>
      </div>

      <div class="panel">
        <h2>${t('players')} <span class="count">${players.length}</span></h2>
        <p class="hint">${alone ? t('waiting_players') : host ? t('order_hint_host') : t('order_hint')}</p>
        <ol class="seats">${seats}</ol>
      </div>

      <div class="panel">${rules}</div>

      <div class="actions">
        <button type="button" class="btn text danger" data-act="askLeave">${t('leave')}</button>
        ${host
          ? `<button type="button" class="btn primary" data-act="start" ${store.busy ? 'disabled' : ''}>${t('start')}</button>`
          : `<p class="waiting">${t('waiting_host')}<span class="dots" aria-hidden="true"></span></p>`}
      </div>
    </section>`;
}

// ---------------------------------------------------------------- 3rd page

function game(store) {
  const { room, players, me } = store.game;
  const self = players.find((p) => p.id === me);
  const turn = players.find((p) => p.id === room.turn_player);
  const myTurn = turn && turn.id === me;
  const left = room.max_kuess ? room.max_kuess - self.kuess_used : null;

  let stage;
  if (myTurn) {
    stage = `
      <div class="stage mine" data-enter="stage-${room.turn_player}">
        <h2 class="turn-line">${t('your_turn')}</h2>
        <div class="stage-card">
          ${card({ name: t('you'), size: 'lg',
                   corner: `<button type="button" class="kuess-btn" data-act="openKuess">${t('kuess')}</button>` })}
        </div>
        <button type="button" class="btn unsure" data-act="pass" ${store.busy ? 'disabled' : ''}>${t('still_not_sure')}</button>
        <p class="chances">${left === null ? t('left_unlimited') : t('left', { n: left })}</p>
      </div>`;
  } else if (turn) {
    stage = `
      <div class="stage" data-enter="stage-${room.turn_player}">
        <h2 class="turn-line">${t('turn_of', { name: esc(turn.name) })}</h2>
        <div class="stage-card">${card({ name: turn.name, number: turn.number, status: turn.state, size: 'lg' })}</div>
        ${self.state !== 'waiting' ? `<p class="chances">${t('done_wait')}</p>` : ''}
      </div>`;
  } else {
    stage = '<div class="stage"></div>';
  }

  const rail = players.map((p) => `
    <li class="rail-seat ${p.id === room.turn_player ? 'is-turn' : ''} ${p.state}">
      ${card({ name: p.id === me ? t('you') : p.name, number: p.number, status: p.state })}
    </li>`).join('');

  const memo = room.memo ? `
    <label class="memo">
      <span>${t('memo')}</span>
      <textarea id="memo" data-input="memo" rows="3" placeholder="${t('memo_ph')}">${esc(store.memo)}</textarea>
    </label>` : '';

  return `
    <section class="game">
      ${room.number_mode === 'random' ? `<p class="range-hint">${t('range_hint', { max: fmt(room.number_max) })}</p>` : ''}
      ${stage}
      <ol class="rail" aria-label="${t('players')}">${rail}</ol>
      ${memo}
      <div class="actions">
        <button type="button" class="btn text danger" data-act="askLeave">${t('leave')}</button>
        ${self.is_host ? `<button type="button" class="btn ghost" data-act="askEnd">${t('end_game')}</button>` : ''}
      </div>
    </section>`;
}

// ---------------------------------------------------------------- summary

function summary(store) {
  const { players, me } = store.game;
  const self = players.find((p) => p.id === me);
  const byTime = (a, b) => new Date(a.done_at) - new Date(b.done_at);
  const solved = players.filter((p) => p.state === 'solved').sort(byTime);
  const out = players.filter((p) => p.state === 'out').sort(byTime);
  const open = players.filter((p) => p.state === 'waiting');

  const list = (title, rows, ranked) => rows.length ? `
    <div class="panel">
      <h2>${title}</h2>
      <ol class="ranks ${ranked ? 'ranked' : ''}">
        ${rows.map((p, i) => `
          <li class="${p.id === me ? 'mine' : ''}">
            ${ranked ? `<span class="rank">${i + 1}</span>` : ''}
            ${card({ number: p.number, size: 'xs' })}
            <span class="rank-name">${esc(p.name)}${p.id === me ? ` <em class="tag">${t('you')}</em>` : ''}</span>
            <span class="rank-meta">${t('used', { n: p.kuess_used })}</span>
          </li>`).join('')}
      </ol>
    </div>` : '';

  return `
    <section class="summary">
      <h1 class="over">${t('game_over')}</h1>
      <div class="reveal" data-enter="reveal">
        <p>${t('your_number_was')}</p>
        <div class="flip">
          <div class="flip-in">
            <div class="flip-back">${card({ name: t('you'), size: 'lg' })}</div>
            <div class="flip-face">${card({ name: t('you'), number: self.number, status: self.state, size: 'lg' })}</div>
          </div>
        </div>
      </div>
      ${list(t('solved_list'), solved, true)}
      ${list(t('out_list'), out, true)}
      ${list(t('unfinished_list'), open, false)}
      <div class="actions">
        <button type="button" class="btn text danger" data-act="askLeave">${t('leave')}</button>
        ${self.is_host
          ? `<button type="button" class="btn primary" data-act="rematch">${t('play_again')}</button>`
          : `<p class="waiting">${t('waiting_rematch')}<span class="dots" aria-hidden="true"></span></p>`}
      </div>
    </section>`;
}

// ---------------------------------------------------------------- overlays

function sheet(store) {
  const s = store.sheet;
  if (!s) return '';
  let body = '';

  if (s.type === 'settings') {
    body = `
      <h2 id="sheet-title">${t('settings')}</h2>
      <div class="rule"><span>${t('language')}</span>
        ${seg('setLang', LANGS.map((l) => [l.code, l.label]), getLang())}</div>
      <p class="credit">★ Krit's vibe code ★</p>
      <button type="button" class="btn ghost wide" data-act="closeSheet" data-autofocus>${t('close')}</button>`;
  }

  if (s.type === 'confirm') {
    body = `
      <h2 id="sheet-title" class="confirm-text">${s.text}</h2>
      <div class="choices">
        <button type="button" class="btn ghost" data-act="closeSheet" data-autofocus>${t('cancel')}</button>
        <button type="button" class="btn danger-solid" data-act="${s.act}">${s.label}</button>
      </div>`;
  }

  if (s.type === 'kuess') {
    const { room, players, me } = store.game;
    const self = players.find((p) => p.id === me);
    const left = room.max_kuess ? room.max_kuess - self.kuess_used : null;
    body = `
      <form data-submit="kuess" novalidate>
        <h2 id="sheet-title">${t('kuess_title')}</h2>
        <input id="guess" class="guess-input" data-input="guess" value="${esc(store.guess)}"
          inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="?" autocomplete="off"
          enterkeyhint="send" aria-label="${t('kuess_title')}" data-autofocus>
        <p class="sheet-note">${room.number_mode === 'random' ? `<span>${t('range_hint', { max: fmt(room.number_max) })}</span>` : ''}<span>${left === null ? t('left_unlimited') : t('left', { n: left })}</span></p>
        <div class="choices">
          <button type="button" class="btn ghost" data-act="closeSheet">${t('cancel')}</button>
          <button type="submit" class="btn primary" ${store.busy ? 'disabled' : ''}>${t('kuess_go')}</button>
        </div>
      </form>`;
  }

  return `
    <div class="scrim" data-act="closeSheet"></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" data-enter="sheet-${s.type}">
      ${body}
    </div>`;
}

function result(store) {
  const r = store.result;
  if (!r) return '';
  const text = { correct: t('correct'), wrong: t('wrong'), out: t('out') }[r.type];
  const sub = r.type === 'correct' ? t('it_was', { n: r.value })
            : r.type === 'wrong' && r.left !== null ? t('left', { n: r.left }) : '';
  return `
    <div class="result ${r.type}" data-act="dismissResult" role="status" data-enter="result-${r.at}">
      <div class="result-in">
        ${card({ name: t('you'), number: r.type === 'correct' ? r.value : null,
                 status: r.type === 'correct' ? 'solved' : r.type === 'out' ? 'out' : 'waiting', size: 'md' })}
        <p class="result-text">${text}</p>
        ${sub ? `<p class="result-sub">${sub}</p>` : ''}
      </div>
    </div>`;
}

// ---------------------------------------------------------------- app

export function view(store) {
  const status = store.game?.room.status;
  const page = status === 'lobby' ? lobby(store)
             : status === 'playing' ? game(store)
             : status === 'finished' ? summary(store)
             : home(store);
  return `${topbar(store)}<main>${page}</main>${sheet(store)}${result(store)}`;
}
