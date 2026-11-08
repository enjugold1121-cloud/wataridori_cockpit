// 操縦席のメイン画面と共通操作。描画は state から毎回作り直す単純な方式。
(function (WB) {
  'use strict';

  const T = WB.time, S = WB.store, state = S.state;
  const FREE = '__free__';
  const ORPHAN = '__orphan__';
  const FOCUS_MS = 45 * 60000;
  const BREAK_MS = 15 * 60000;
  const BAND_LABEL = { am: '午前', pm: '午後', eve: '夕方・夜' };
  const BANDS = ['am', 'pm', 'eve'];
  const PEEK_MS = 2 * 60000;
  const EVENTS_TTL_MS = 10 * 60000;   // Googleカレンダーの予定を取り直す間隔
  const TASK_HINT_LIMIT = 3;

  const $ = (q, root = document) => root.querySelector(q);
  const $$ = (q, root = document) => [...root.querySelectorAll(q)];
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ui = {
    tab: 'today',           // 小さい画面で表示中のカラム
    events: {},             // 日付 → 予定の一覧
    eventsLoadedAt: 0,      // 予定を最後に取りにいった時刻
    loadingCount: 0,
    pendingLoads: {},       // 取得中の範囲（同じ範囲を重ねて取りにいかない）
    pendingRemote: false,   // 操作中に届いた共有の変更（操作が終わってから描き直す）
    expanded: new Set(),    // 手動で開いた時間ブロック
    focusBlock: null,       // 直前に開いた時間ブロック
    undo: null,             // 元に戻す用のスナップショット
    adding: null,           // 追加入力中の一覧
    skipBlur: false,
    peek: null,             // 他の時間帯の雛形を編集中なら band
    peekUntil: 0,
    sheet: null,
    dragging: false,
    justDragged: false,
    lastSig: '',
  };

  const today = () => T.operatingDay(new Date(), state.settings);
  const onCalendar = () => location.hash === '#/calendar';

  function bandRange(band) {
    const s = state.settings;
    if (band === 'am') return `${s.amStart}〜${s.pmStart}`;
    if (band === 'pm') return `${s.pmStart}〜${s.eveStart}`;
    return `${s.eveStart}〜翌${s.amStart}`;
  }

  /* ---------- 時間ブロック ---------- */

  async function loadEvents(from, to) {
    ui.loadingCount++;
    try {
      Object.assign(ui.events, await WB.calendarProvider.getEvents(from, to));
    } finally {
      ui.loadingCount--;
      ui.eventsLoadedAt = Date.now();
      renderStatus();
    }
  }

  function ensureEvents(from, to) {
    const key = `${from}_${to}`;
    if (ui.pendingLoads[key]) return;
    ui.pendingLoads[key] = loadEvents(from, to).finally(() => {
      delete ui.pendingLoads[key];
      refresh();
    });
  }

  // 表示中の日の予定を取り直し、変わっていれば描き直す
  async function reloadEvents() {
    const days = onCalendar() ? WB.calendarView.days() : [today()];
    const before = JSON.stringify(days.map(d => ui.events[d] || null));
    await loadEvents(days[0], days[days.length - 1]);
    const changed = JSON.stringify(days.map(d => ui.events[d] || null)) !== before;
    if (changed && !ui.dragging && !ui.adding) refresh();
  }

  // 予定に付箋を重ねた一覧。「時間未定」は付箋があるか予定がない日にだけ出す。
  // 予定が消えた・別の日へ動いた付箋は、消さずに「予定が見つからない付箋」として出す。
  function blocksFor(day, { includeFree = false } = {}) {
    const events = ui.events[day] || [];
    const blocks = events
      .slice()
      .sort((a, b) => a.start.localeCompare(b.start))
      .map(ev => ({ ...ev, tasks: S.tasks(day, ev.id) }));
    const free = S.tasks(day, FREE);
    if (includeFree || free.length || !blocks.length) {
      blocks.push({ id: FREE, title: '時間未定', start: null, end: null, kind: 'free', tasks: free });
    }
    const orphans = orphanBlockIds(day);
    if (orphans.length) {
      const lists = orphans.map(blockId => ({ blockId, tasks: S.tasks(day, blockId) }));
      const title = WB.calendarProvider.status === 'error' ? '予定を確認できない付箋' : '予定が見つからない付箋';
      blocks.push({ id: ORPHAN, title, start: null, end: null, kind: 'orphan', lists, tasks: lists.flatMap(l => l.tasks) });
    }
    return blocks;
  }

  // 付箋はあるのに、その日の予定に見当たらないブロック（予定の取得前は判定しない）
  function orphanBlockIds(day) {
    if (!ui.events[day]) return [];
    const ids = new Set(ui.events[day].map(ev => ev.id));
    return Object.keys(state.work[day] || {}).filter(id => id !== FREE && !ids.has(id));
  }

  const isEventBlock = (day, blockId) => (ui.events[day] || []).some(ev => ev.id === blockId);

  function blockTitle(day, blockId) {
    const block = blocksFor(day, { includeFree: true }).find(b => b.id === blockId);
    return block ? block.title : '';
  }

  function phaseOf(block, day) {
    if (!block.start) return 'free';
    if (day !== today()) return 'other';
    const m = T.opMinutes(new Date(), state.settings);
    if (m >= T.toMin(block.end)) return 'past';
    return m >= T.toMin(block.start) ? 'current' : 'future';
  }

  /* ---------- 付箋の部品 ---------- */

  function addRowHTML(placeholder) {
    return `<li class="note note-add" data-nodrag><input class="add-input" type="text" enterkeyhint="done" maxlength="200" placeholder="${placeholder}" aria-label="${placeholder}"></li>`;
  }

  // 文字の上は編集、それ以外の余白はチェック（余白のタップで編集が開かないようにする）。
  // 短い文は編集の範囲が狭すぎて誤って完了しやすいので、4文字分の幅を確保する。
  function noteTextHTML(text) {
    const short = [...text].length <= 6 ? ' is-short' : '';
    return `<div class="note-text"><span class="note-body${short}" data-act="edit" role="button" tabindex="0">${esc(text)}</span></div>`;
  }

  const REPEAT_MARK = '<svg class="repeat-mark" viewBox="0 0 16 16" role="img" aria-label="くり返し"><path d="M12.8 5.6A5.2 5.2 0 0 0 3.4 4.6M3.2 10.4a5.2 5.2 0 0 0 9.4 1" /><path d="M3.2 1.9v2.9h2.9M12.8 14.1v-2.9H9.9" /></svg>';

  function workNoteHTML(task) {
    return `<li class="note note-work${task.done ? ' is-done' : ''}${task.repeatId ? ' is-repeat' : ''}" data-id="${task.id}" data-act="toggle-work">
      <button class="check" data-act="toggle-work" data-nodrag aria-pressed="${task.done}" aria-label="完了にする"><span></span></button>
      ${noteTextHTML(task.text)}${task.repeatId ? REPEAT_MARK : ''}
    </li>`;
  }

  function stripHTML(day, block, { panel = false } = {}) {
    const phase = phaseOf(block, day);
    const total = block.tasks.length;
    const done = block.tasks.filter(t => t.done).length;
    const adding = ui.adding && ui.adding.kind === 'work' && ui.adding.day === day && ui.adding.blockId === block.id;
    const showTimer = !panel && phase === 'current' && block.kind === 'work';
    const canCollapse = !panel && phase !== 'current';
    return `<article class="strip is-${phase} kind-${block.kind}${panel ? ' is-panel' : ''}" data-block="${esc(block.id)}" data-default-collapsed="${!panel && phase === 'past' ? 1 : 0}">
      <div class="strip-time"${canCollapse ? ' data-act="toggle-strip"' : ''}>
        <span class="t-start">${block.start || (block.kind === 'orphan' ? '―' : '未定')}</span>
        ${block.end ? `<span class="t-end">${block.end}</span>` : ''}
      </div>
      <div class="strip-main">
        <header class="strip-head">
          <div class="strip-title-wrap"${canCollapse ? ' data-act="toggle-strip"' : ''}>
            <h3 class="strip-title">${esc(block.title)}</h3>
            ${block.kind === 'fixed' ? '<span class="kind-tag">予定</span>' : ''}
            ${phase === 'current' ? '<span class="now-badge">いま</span>' : ''}
            ${phase === 'current' && !panel ? `<span class="now-left" id="now-left" data-end="${T.toMin(block.end)}"></span>` : ''}
            ${total ? `<span class="strip-count">${done}/${total}</span>` : ''}
          </div>
          ${showTimer ? '<div class="timer-slot"></div>' : ''}
          ${block.kind === 'orphan'
            ? `<button class="btn btn-quiet btn-small" data-act="clear-orphans" data-day="${day}">すべて削除</button>`
            : `<button class="icon-btn icon-btn-small" data-act="add" data-kind="work" data-day="${day}" data-block="${esc(block.id)}" aria-label="${esc(block.title)}に付箋を追加">＋</button>`}
        </header>
        ${(block.lists || [{ blockId: block.id, tasks: block.tasks }]).map(list =>
          `<ul class="notes notes-work" data-kind="work" data-day="${day}" data-block="${esc(list.blockId)}">${list.tasks.map(workNoteHTML).join('')}${adding ? addRowHTML('付箋を追加') : ''}</ul>`).join('')}
        ${block.kind === 'orphan' ? `<p class="strip-hint">${WB.calendarProvider.status === 'error'
          ? '予定を取得できないため、時間割に置けない付箋です。'
          : '予定が消えたか、別の日へ移った付箋です。別の時間へ移すか、削除してください。'}</p>` : ''}
        ${total > TASK_HINT_LIMIT && block.kind !== 'orphan' ? '<p class="strip-hint">1ブロック3個までがおすすめ</p>' : ''}
      </div>
      ${phase === 'current' && !panel ? `<div class="strip-progress" id="strip-progress" data-start="${T.toMin(block.start)}" data-end="${T.toMin(block.end)}"></div>` : ''}
    </article>`;
  }

  /* ---------- 各カラムの描画 ---------- */

  function renderHold() {
    const day = today();
    const list = $('#hold-list');
    const holds = S.orderedHolds(day);
    $('#hold-count').textContent = holds.length ? `${holds.length}件` : '';
    const adding = ui.adding && ui.adding.kind === 'hold';
    list.innerHTML = (adding ? addRowHTML('今はやらないこと') : '') + holds.map(h => {
      const due = h.reviewDate && h.reviewDate <= day;
      const important = S.isImportantHold(h, day);
      const chip = h.reviewDate
        ? `<span class="chip${due ? ' chip-due' : ''}">${due ? '再検討日です' : `再検討 ${T.shortDate(h.reviewDate)}`}</span>`
        : '';
      return `<li class="note note-hold${important ? ' is-important' : ''}${h.pinned ? ' is-pinned' : ''}" data-id="${h.id}">
        <div class="note-body" data-act="edit" role="button" tabindex="0">${esc(h.text)}</div>
        <div class="note-foot">
          ${h.pinned ? '<span class="chip chip-pin">固定</span>' : ''}${chip}
          <button class="note-go" data-act="hold-to-today" data-nodrag>今日へ</button>
        </div>
      </li>`;
    }).join('');
    if (!holds.length && !adding) list.innerHTML = '<li class="empty">今は保留なし</li>';
  }

  function nowMarkerHTML(text, leftAttr) {
    return `<p class="now-marker">${esc(text)}${leftAttr ? `<span id="next-left" data-start="${leftAttr}"></span>` : ''}</p>`;
  }

  function renderToday() {
    const day = today();
    const isAfterMidnight = day !== T.dayKey(new Date());
    $('#today-sub').textContent = `${T.dayLabel(day)}${isAfterMidnight ? 'の続き' : ''}`;
    const blocks = blocksFor(day);
    const scheduled = blocks.filter(b => b.start);
    const hasCurrent = scheduled.some(b => phaseOf(b, day) === 'current');
    const next = scheduled.find(b => phaseOf(b, day) === 'future');
    const html = [];
    blocks.forEach(b => {
      if (!hasCurrent && next && b.id === next.id) {
        html.push(nowMarkerHTML(`いまは予定なし。次は ${b.start} ${b.title}`, T.toMin(b.start)));
      }
      if (!hasCurrent && !next && scheduled.length && b.id === FREE) {
        html.push(nowMarkerHTML('今日の予定はここまで'));
      }
      html.push(stripHTML(day, b));
    });
    if (!hasCurrent && !next && scheduled.length && !blocks.some(b => b.id === FREE)) {
      html.push(nowMarkerHTML('今日の予定はここまで'));
    }
    $('#timeline').innerHTML = html.join('');
    renderTimer();
  }

  function renderLife() {
    const now = new Date();
    const day = today();
    const current = T.bandAt(now, state.settings);
    const band = ui.peek || current;
    const items = state.lifeTemplate[band];
    const list = $('#life-list');
    const adding = ui.adding && ui.adding.kind === 'life';
    list.dataset.band = band;
    const doneCount = items.filter(i => S.lifeDone(day, i.id)).length;
    $('#life-sub').innerHTML = ui.peek
      ? '毎日の付箋を編集中'
      : `<strong>${BAND_LABEL[band]}</strong> ${bandRange(band)}${items.length ? `<span class="life-count">${doneCount}/${items.length}</span>` : ''}`;
    list.innerHTML = items.map(item => {
      const done = !ui.peek && S.lifeDone(day, item.id);
      return `<li class="note note-life${done ? ' is-done' : ''}" data-id="${item.id}" data-act="${ui.peek ? 'edit' : 'toggle-life'}">
        ${ui.peek ? '' : `<button class="check" data-act="toggle-life" data-nodrag aria-pressed="${done}" aria-label="完了にする"><span></span></button>`}
        ${noteTextHTML(item.text)}
      </li>`;
    }).join('') + (adding ? addRowHTML('毎日くり返す付箋') : '');
    if (!items.length && !adding) list.innerHTML = '<li class="empty">この時間帯の付箋はなし</li>';

    if (ui.peek) {
      $('#life-foot').innerHTML = `<div class="segmented">${BANDS.map(b =>
        `<button class="seg${b === band ? ' is-on' : ''}" data-act="peek-band" data-band="${b}">${BAND_LABEL[b]}</button>`).join('')}</div>
        <button class="btn btn-quiet" data-act="peek-close">編集を閉じる</button>`;
    } else {
      const nextBand = BANDS[(BANDS.indexOf(band) + 1) % 3];
      const nextStart = { am: state.settings.amStart, pm: state.settings.pmStart, eve: state.settings.eveStart }[nextBand];
      $('#life-foot').innerHTML = `<p class="life-next">次は ${nextStart} から${BAND_LABEL[nextBand]}</p>
        <button class="btn btn-quiet" data-act="peek-open">他の時間帯を編集</button>`;
    }
  }

  // 収まらないときは文字を小さくせず、遠い予定から順に1行へ畳む
  function fitTimeline() {
    const list = $('#timeline');
    if (!list || !list.offsetParent) return;
    const strips = $$('.strip', list);
    strips.forEach(s => {
      const defaultCollapsed = s.dataset.defaultCollapsed === '1';
      s.classList.toggle('is-collapsed', defaultCollapsed && !ui.expanded.has(s.dataset.block));
    });
    const collapsible = strips
      .filter(s => !s.classList.contains('is-current') && !s.classList.contains('is-free') && !s.classList.contains('is-collapsed'))
      .filter(s => s.dataset.block !== ui.focusBlock)
      .reverse();
    // 手動で開いたものは、それでも収まらないときだけ畳む（直前に触ったブロックは閉じない）
    const order = [
      ...collapsible.filter(s => !ui.expanded.has(s.dataset.block)),
      ...collapsible.filter(s => ui.expanded.has(s.dataset.block)),
    ];
    for (const s of order) {
      if (list.scrollHeight <= list.clientHeight + 1) break;
      s.classList.add('is-collapsed');
    }
  }

  // 保留が増えたら、重要な付箋以外を1行表示にする
  function fitHolds() {
    const list = $('#hold-list');
    if (!list || !list.offsetParent) return;
    list.classList.remove('is-dense');
    if (list.scrollHeight > list.clientHeight + 1) list.classList.add('is-dense');
  }

  function renderMain() {
    renderHold();
    renderToday();
    renderLife();
    $('#page-main').dataset.tab = ui.tab;
    $$('.tab').forEach(t => t.classList.toggle('is-on', t.dataset.tab === ui.tab));
    fitTimeline();
    fitHolds();
    updateNowBits();
  }

  function refresh() {
    const cal = onCalendar();
    if (cal) {
      const days = WB.calendarView.days();
      if (days.some(d => !ui.events[d])) {
        ensureEvents(days[0], days[days.length - 1]);
        return;
      }
    } else if (!ui.events[today()]) {
      ensureEvents(today(), today());
      return;
    }
    // くり返し付箋は今日以降の表示中の日にだけ貼る（過ぎた日には後から足さない）
    const visibleDays = cal ? WB.calendarView.days() : [today()];
    visibleDays.filter(d => d >= today()).forEach(d => S.placeRepeats(d, ui.events[d] || []));
    $('#page-main').hidden = cal;
    $('#page-calendar').hidden = !cal;
    $('.tabs').hidden = cal;
    $('#nav-btn').textContent = cal ? '操縦席へ戻る' : '全体カレンダー';
    if (cal) WB.calendarView.render();
    else renderMain();
    bindSortables();
    const input = $('.add-input');
    if (input) input.focus();
  }

  function renderClock() {
    const now = new Date();
    $('#clock-date').textContent = T.dayLabel(T.dayKey(now));
    $('#clock-time').textContent = T.clock(now);
  }

  function renderStatus() {
    const P = WB.calendarProvider;
    let html;
    if (!P.connected) {
      html = '<span class="status-dot"></span><span><span class="status-google">Google</span>カレンダー未接続</span><span class="status-more">（サンプル予定を表示中）</span>';
    } else if (P.status === 'error') {
      html = '<span class="status-dot is-error"></span><span><span class="status-google">Google</span>カレンダーを取得できません</span><span class="status-more">（前回の予定を表示中）</span>';
    } else if (WB.sync.enabled && WB.sync.error) {
      html = '<span class="status-dot is-error"></span><span>付箋を共有できません</span><span class="status-more">（この端末には保存済み）</span>';
    } else {
      const at = P.updatedAt ? `（${T.clock(P.updatedAt)} 更新）` : '';
      html = `<span class="status-dot is-on"></span><span><span class="status-google">Google</span>カレンダー接続済み</span><span class="status-more">${at}</span>`;
    }
    // 表示を押すと設定（接続先の確認）を開く
    $('#cal-status').innerHTML = `<button class="status-btn" data-act="settings">${html}</button>`;
  }

  function updateNowBits() {
    const m = T.opMinutes(new Date(), state.settings);
    const left = $('#now-left');
    if (left) left.textContent = `あと${T.leftLabel(Math.max(0, Number(left.dataset.end) - m))}`;
    const progress = $('#strip-progress');
    if (progress) {
      const start = Number(progress.dataset.start);
      const end = Number(progress.dataset.end);
      progress.style.width = `${Math.min(100, Math.max(0, (m - start) / (end - start) * 100))}%`;
    }
    const nextLeft = $('#next-left');
    if (nextLeft) nextLeft.textContent = `（あと${T.leftLabel(Math.max(0, Number(nextLeft.dataset.start) - m))}）`;
  }

  /* ---------- 45分＋15分タイマー ---------- */

  let audio = null;
  function unlockAudio() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!audio && Ctx) audio = new Ctx();
      if (audio && audio.state === 'suspended') audio.resume();
    } catch (e) { audio = null; }
  }

  function chime() {
    if (!state.settings.chime || !audio) return;
    const t0 = audio.currentTime;
    [660, 880].forEach((freq, i) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      const at = t0 + i * 0.22;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.linearRampToValueAtTime(0.12, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.9);
      osc.connect(gain).connect(audio.destination);
      osc.start(at);
      osc.stop(at + 1);
    });
  }

  function timerLeft() {
    const t = state.timer;
    return t.pausedLeft !== null ? t.pausedLeft : Math.max(0, t.endsAt - Date.now());
  }

  function timerText() {
    const sec = Math.ceil(timerLeft() / 1000);
    return `${T.pad(Math.floor(sec / 60))}:${T.pad(sec % 60)}`;
  }

  function timerHTML() {
    const t = state.timer;
    if (t.phase === 'idle') return '<button class="timer-start" data-act="timer-start">45分集中を始める</button>';
    const paused = t.pausedLeft !== null;
    const label = t.phase === 'break' ? '休憩' : (paused ? '一時停止中' : '集中');
    const buttons = t.phase === 'break'
      ? '<button class="timer-btn" data-act="timer-stop">休憩を終える</button>'
      : `<button class="timer-btn" data-act="${paused ? 'timer-resume' : 'timer-pause'}">${paused ? '再開' : '一時停止'}</button>
         <button class="timer-btn" data-act="timer-stop">終了</button>`;
    return `<div class="timer is-${t.phase}" role="timer"><span class="timer-label">${label}</span><span class="timer-time" id="timer-time">${timerText()}</span>${buttons}</div>`;
  }

  // 時間ブロックの中に出す。実行中に予定の外へ出たら見出し横へ移す。
  function renderTimer() {
    const inStrip = $('.strip .timer-slot');
    const head = $('#today-timer');
    if (head) head.innerHTML = '';
    const slot = inStrip || (state.timer.phase !== 'idle' ? head : null);
    if (slot) slot.innerHTML = timerHTML();
  }

  function tickTimer() {
    const t = state.timer;
    if (t.phase !== 'idle' && t.pausedLeft === null) {
      let changed = false;
      while (t.phase !== 'idle' && Date.now() >= t.endsAt) {
        if (t.phase === 'focus') {
          t.phase = 'break';
          t.endsAt += BREAK_MS;
        } else {
          t.phase = 'idle';
          t.endsAt = null;
        }
        changed = true;
      }
      if (changed) {
        S.commit('timer');
        chime();
        if (!onCalendar()) renderTimer();
      }
    }
    const el = $('#timer-time');
    if (el) el.textContent = timerText();
  }

  /* ---------- 時刻の更新 ---------- */

  function signature() {
    const now = new Date();
    const day = today();
    const blocks = (ui.events[day] || []).map(b => phaseOf(b, day)).join(',');
    return [day, T.bandAt(now, state.settings), blocks].join('|');
  }

  function tick() {
    renderClock();
    tickTimer();
    if (ui.dragging || ui.adding) return;
    if (ui.pendingRemote) {
      ui.pendingRemote = false;
      refresh();
    }
    if (WB.calendarProvider.connected && !ui.loadingCount && Date.now() - ui.eventsLoadedAt > EVENTS_TTL_MS) {
      reloadEvents();
    }
    if (ui.peek && Date.now() > ui.peekUntil) {
      ui.peek = null;
      if (!onCalendar()) renderLife();
    }
    const sig = signature();
    if (sig !== ui.lastSig) {
      const dayChanged = sig.split('|')[0] !== ui.lastSig.split('|')[0];
      ui.lastSig = sig;
      if (dayChanged) {
        ui.expanded.clear();
        ui.focusBlock = null;
      }
      refresh();
    } else if (!onCalendar()) {
      updateNowBits();
    }
  }

  /* ---------- ドラッグ ---------- */

  let sortables = [];

  function listRefOf(ul) {
    const { kind, day, block, band } = ul.dataset;
    return { kind, day, blockId: block, band };
  }

  function refFrom(el) {
    const note = el.closest('.note');
    return { ...listRefOf(note.closest('.notes')), id: note.dataset.id };
  }

  function bindSortables() {
    sortables.forEach(s => s.destroy());
    sortables = $$('.notes').filter(el => !el.closest('.is-collapsed')).map(el => new window.Sortable(el, {
      group: el.dataset.kind === 'life' ? 'life' : 'tasks',
      draggable: '.note[data-id]',
      filter: '[data-nodrag]',
      preventOnFilter: false,
      animation: 160,
      delay: 180,
      delayOnTouchOnly: true,
      touchStartThreshold: 6,
      forceFallback: true,
      fallbackOnBody: true,
      fallbackTolerance: 3,
      emptyInsertThreshold: 16,
      ghostClass: 'note-ghost',
      chosenClass: 'note-chosen',
      dragClass: 'note-drag',
      onStart() {
        ui.dragging = true;
        document.body.classList.add('is-dragging');
      },
      onEnd(evt) {
        ui.dragging = false;
        document.body.classList.remove('is-dragging');
        ui.justDragged = true;
        setTimeout(() => { ui.justDragged = false; }, 350);
        if (evt.from === evt.to && evt.oldDraggableIndex === evt.newDraggableIndex) return;
        const order = $$(':scope > .note[data-id]', evt.to).map(n => n.dataset.id);
        const moved = S.transfer(listRefOf(evt.from), listRefOf(evt.to), evt.item.dataset.id, order);
        if (!moved) toast('完了した付箋は保留へ移せません');
        // Sortable の後処理が終わってから描き直す
        setTimeout(refresh, 0);
      },
    }));
  }

  function withFlip(fn) {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const before = new Map($$('.note[data-id]').map(n => [n.dataset.id, n.getBoundingClientRect()]));
    fn();
    if (reduce) return;
    $$('.note[data-id]').forEach(n => {
      const a = before.get(n.dataset.id);
      const b = n.getBoundingClientRect();
      if (!b.width) return;
      if (!a || !a.width) {
        n.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
        return;
      }
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (dx || dy) {
        n.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 240, easing: 'cubic-bezier(.2,.7,.3,1)' });
      }
    });
  }

  /* ---------- トースト ---------- */

  let toastTimer = null;
  function toast(message, undoSnapshot) {
    const el = $('#toast');
    ui.undo = undoSnapshot || null;
    el.innerHTML = `<span>${esc(message)}</span>${undoSnapshot ? '<button class="toast-undo" data-act="undo">元に戻す</button>' : ''}`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; ui.undo = null; }, 7000);
  }

  /* ---------- 編集シート ---------- */

  function openSheet(ref, mode = 'edit', pickDay = null) {
    ui.sheet = { ref, mode, pickDay };
    renderSheet();
    const dlg = $('#sheet');
    if (!dlg.open) dlg.showModal();
  }

  function closeSheet() {
    const dlg = $('#sheet');
    if (dlg.open) dlg.close();
  }

  function sheetPosition(ref) {
    let list;
    if (ref.kind === 'hold') {
      const ordered = S.orderedHolds(today());
      const item = ordered.find(h => h.id === ref.id);
      list = ordered.filter(h => S.isImportantHold(h, today()) === S.isImportantHold(item, today()));
    } else {
      list = ref.kind === 'life' ? state.lifeTemplate[ref.band] : S.tasks(ref.day, ref.blockId);
    }
    return { index: list.findIndex(x => x.id === ref.id), count: list.length };
  }

  function renderPicker(ref, day) {
    const isToday = day === today();
    const blocks = blocksFor(day, { includeFree: true }).filter(b => {
      if (ref.kind === 'work' && ref.day === day && ref.blockId === b.id) return false;
      if (b.kind === 'orphan') return false;
      return !isToday || phaseOf(b, day) !== 'past';
    });
    return `<header class="sheet-head">
        <h2>${isToday ? '今日のどの時間に移しますか' : `${T.dayLabel(day)}のどの時間に移しますか`}</h2>
        <button class="btn btn-quiet" data-act="sheet-back">戻る</button>
      </header>
      <p class="sheet-quote">${esc(S.find(ref).text)}</p>
      <div class="pick-list">
        ${blocks.map(b => `<button class="pick" data-act="pick-block" data-block="${esc(b.id)}">
          <span class="pick-time">${b.start ? `${b.start}〜${b.end}` : '時間未定'}</span>
          <span class="pick-title">${b.id === FREE ? '時間を決めずに置く' : esc(b.title)}</span>
          ${phaseOf(b, day) === 'current' ? '<span class="now-badge">いま</span>' : ''}
          <span class="pick-count">${b.tasks.length ? `${b.tasks.length}個` : ''}</span>
        </button>`).join('')}
      </div>`;
  }

  function renderSheet() {
    const { ref, mode, pickDay } = ui.sheet;
    const dlg = $('#sheet');
    const item = S.find(ref);
    if (!item) { closeSheet(); return; }
    dlg.dataset.kind = ref.kind;
    if (mode === 'pick') {
      dlg.innerHTML = renderPicker(ref, pickDay);
      return;
    }
    const { index, count } = sheetPosition(ref);
    const isWork = ref.kind === 'work';
    const repeat = isWork && item.repeatId ? S.repeatOf(item.repeatId) : null;
    const titles = { hold: '保留の付箋', work: repeat ? 'くり返しの付箋' : '仕事の付箋', life: '生活の付箋' };
    const orderLabels = isWork ? ['↑ 前へ', '↓ 後へ'] : ['↑ 上へ', '↓ 下へ'];
    const moves = [];
    if (ref.kind === 'hold') {
      moves.push('<button class="btn" data-act="sheet-pick-today">今日へ移す</button>');
    }
    if (isWork && !item.done) {
      if (ref.day === today()) moves.push('<button class="btn" data-act="sheet-to-hold">保留へ移す</button>');
      else moves.push('<button class="btn" data-act="sheet-pick-today">今日へ移す</button>', '<button class="btn" data-act="sheet-to-hold">保留へ移す</button>');
      moves.push('<button class="btn" data-act="sheet-pick-same">別の時間へ</button>');
    }
    dlg.innerHTML = `<header class="sheet-head">
        <h2>${titles[ref.kind]}</h2>
        <button class="btn btn-quiet" data-act="sheet-close" autofocus>閉じる</button>
      </header>
      <label class="field">
        <span class="field-label">内容（自動で保存）</span>
        <textarea id="sheet-text" rows="2" maxlength="200">${esc(item.text)}</textarea>
      </label>
      ${ref.kind === 'hold' ? `<div class="field-row">
        <label class="field field-grow">
          <span class="field-label">再検討日（任意）</span>
          <input id="sheet-review" type="date" value="${item.reviewDate || ''}">
        </label>
        <button class="btn${item.pinned ? ' is-on' : ''}" data-act="sheet-pin" aria-pressed="${item.pinned}">${item.pinned ? '固定を外す' : '上に固定'}</button>
      </div>` : ''}
      ${ref.kind === 'life' ? `<div class="field">
        <span class="field-label">時間帯（毎日くり返します）</span>
        <div class="segmented">${BANDS.map(b => `<button class="seg${b === ref.band ? ' is-on' : ''}" data-act="sheet-band" data-band="${b}">${BAND_LABEL[b]}</button>`).join('')}</div>
      </div>` : ''}
      ${isWork && (repeat || isEventBlock(ref.day, ref.blockId)) ? `<div class="field">
        <span class="field-label">くり返し</span>
        ${repeat
          ? `<p class="field-hint">予定「${esc(repeat.title)}」がある日に、毎回この付箋を貼ります。文字の変更は次回以降にも反映されます。</p>
             <div><button class="btn" data-act="sheet-stop-repeat">くり返しをやめる</button></div>`
          : `<p class="field-hint">同じ名前の予定「${esc(blockTitle(ref.day, ref.blockId))}」がある日に、この付箋を自動で貼ります。</p>
             <div><button class="btn" data-act="sheet-repeat">この予定に毎回出す</button></div>`}
      </div>` : ''}
      <div class="sheet-actions">
        <div class="btn-group">
          <button class="btn" data-act="sheet-up"${index <= 0 ? ' disabled' : ''}>${orderLabels[0]}</button>
          <button class="btn" data-act="sheet-down"${index >= count - 1 ? ' disabled' : ''}>${orderLabels[1]}</button>
        </div>
        ${moves.join('')}
      </div>
      <footer class="sheet-foot">
        <button class="btn btn-danger" data-act="sheet-delete">${repeat ? 'この日だけ削除' : '削除'}</button>
      </footer>`;
  }

  function openStrip(blockId) {
    ui.expanded.add(blockId);
    ui.focusBlock = blockId;
  }

  function moveToBlock(ref, day, blockId) {
    const snap = S.snapshot();
    withFlip(() => {
      S.transfer(ref, { kind: 'work', day, blockId }, ref.id);
      openStrip(blockId);
      refresh();
    });
    closeSheet();
    toast(`「${blockTitle(day, blockId)}」へ移しました`, snap);
  }

  /* ---------- 設定 ---------- */

  function openSettings() {
    const s = state.settings;
    const dlg = $('#settings');
    dlg.innerHTML = `<header class="sheet-head">
        <h2>設定</h2>
        <button class="btn btn-quiet" data-act="settings-close" autofocus>閉じる</button>
      </header>
      <div class="field">
        <span class="field-label">生活の付箋の時間帯（開始時刻）</span>
        <div class="field-row">
          <label class="field field-grow"><span class="field-hint">午前</span><input type="time" data-setting="amStart" value="${s.amStart}"></label>
          <label class="field field-grow"><span class="field-hint">午後</span><input type="time" data-setting="pmStart" value="${s.pmStart}"></label>
          <label class="field field-grow"><span class="field-hint">夕方・夜</span><input type="time" data-setting="eveStart" value="${s.eveStart}"></label>
        </div>
        <p class="field-hint" id="settings-msg">午前の開始時刻で1日が切り替わり、生活のチェックがリセットされます。</p>
      </div>
      <div class="field">
        <span class="field-label">画面の明るさ</span>
        <div class="segmented">
          <button class="seg${s.theme !== 'dark' ? ' is-on' : ''}" data-act="set-theme" data-theme-value="light">ライト</button>
          <button class="seg${s.theme === 'dark' ? ' is-on' : ''}" data-act="set-theme" data-theme-value="dark">ダーク</button>
        </div>
      </div>
      <label class="check-row"><input type="checkbox" id="setting-chime"${s.chime ? ' checked' : ''}> 45分と15分の区切りで小さな音を鳴らす</label>
      <div class="field">
        <span class="field-label">Googleカレンダー連携（読み取りのみ）</span>
        <label class="field field-tight"><span class="field-hint">中継URL（Apps Script の Web アプリの URL）</span>
          <input type="url" id="cal-url" value="${esc(s.calendarUrl)}" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        <label class="field field-tight"><span class="field-hint">鍵</span>
          <input type="text" id="cal-key" value="${esc(s.calendarKey)}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        <div class="btn-group">
          <button class="btn" data-act="cal-connect">${WB.calendarProvider.connected ? '保存し直す' : '接続する'}</button>
          ${WB.calendarProvider.connected ? '<button class="btn btn-quiet" data-act="cal-disconnect">接続を解除</button>' : ''}
        </div>
        <p class="field-hint" id="cal-msg">${esc(calendarStatusText())}</p>
      </div>
      ${syncSectionHTML()}
      <p class="field-hint">${WB.sync.enabled
        ? '付箋・保留・生活の付箋・完了履歴は、この端末とGoogleドライブに保存します。設定とタイマーは端末ごとです。'
        : 'データはこのブラウザの中だけに保存します。'}</p>`;
    if (!dlg.open) dlg.showModal();
  }

  function syncSectionHTML() {
    let body;
    if (!WB.calendarProvider.connected) {
      body = '<p class="field-hint">先に「Googleカレンダー連携」をつないでください。同じ中継を使って共有します。</p>';
    } else if (!WB.sync.enabled) {
      body = `<p class="field-hint">付箋・保留・生活の付箋・完了履歴を、Googleドライブを通して他の端末と共有します。最初に共有を始めた端末の内容が基準になります。</p>
        <div><button class="btn" data-act="sync-enable">共有を始める</button></div>`;
    } else {
      body = `<div class="btn-group">
          <button class="btn" data-act="sync-now">今すぐ同期</button>
          <button class="btn btn-quiet" data-act="sync-disable">共有をやめる</button>
        </div>`;
    }
    return `<div class="field">
        <span class="field-label">PCとiPadで付箋を共有</span>
        ${body}
        <p class="field-hint${WB.sync.enabled && WB.sync.error ? ' is-error' : ''}" id="sync-msg">${esc(syncStatusText())}</p>
      </div>`;
  }

  function syncStatusText() {
    const Y = WB.sync;
    if (!Y.enabled) return '';
    if (Y.error) return `共有できませんでした（${Y.error}）。この端末には保存されていて、つながったら送ります。`;
    return Y.lastSyncAt ? `共有されています（${T.clock(Y.lastSyncAt)} 同期）。` : '共有されています。';
  }

  async function enableSync() {
    const msg = $('#sync-msg');
    msg.classList.remove('is-error');
    msg.textContent = '共有の準備をしています…';
    try {
      const result = await WB.sync.enable(() => window.confirm(
        '共有データがすでにあります。\nこの端末の付箋・保留・生活の付箋・完了履歴は、共有データに置き換わります（いまの内容は端末に控えを残します）。\n\n置き換えて共有を始めますか？'));
      if (result === 'cancelled') {
        msg.textContent = '共有は始めていません。';
        return;
      }
      openSettings();
      $('#sync-msg').textContent = result === 'uploaded' ? 'この端末の内容で共有を始めました。' : '共有データを読み込みました。';
      refresh();
    } catch (e) {
      msg.textContent = `共有を始められませんでした：${e.message}`;
      msg.classList.add('is-error');
    }
  }

  function calendarStatusText() {
    const P = WB.calendarProvider;
    if (!P.connected) return 'いまはサンプルの予定を表示しています。';
    if (P.status === 'error') return `予定を取得できませんでした（${P.error}）。前回の予定を表示しています。`;
    return P.updatedAt ? `接続されています（${T.clock(P.updatedAt)} 更新）。` : '接続されています。';
  }

  async function connectCalendar() {
    const url = $('#cal-url').value.trim().split(/[?#]/)[0];
    const key = $('#cal-key').value.trim();
    const msg = $('#cal-msg');
    const fail = text => {
      msg.textContent = text;
      msg.classList.add('is-error');
    };
    if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url) || !key) {
      fail('中継URL（/exec で終わるもの）と鍵を入れてください。');
      return;
    }
    msg.classList.remove('is-error');
    msg.textContent = '接続を確かめています…';
    try {
      const data = await WB.calendarProvider.fetchRange({ calendarUrl: url, calendarKey: key }, today(), today());
      Object.assign(state.settings, { calendarUrl: url, calendarKey: key });
      S.commit('settings');
      openSettings();
      $('#cal-msg').textContent = `接続しました。今日の予定は${(data.days[today()] || []).length}件です。`;
      // サンプルの予定を捨てて、Googleカレンダーから取り直す
      ui.events = {};
      refresh();
    } catch (e) {
      fail(`接続できませんでした：${e.message}`);
    }
  }

  function applyTheme() {
    document.documentElement.dataset.theme = state.settings.theme === 'dark' ? 'dark' : 'light';
    $('meta[name="theme-color"]').content = state.settings.theme === 'dark' ? '#1D2125' : '#F7F5F0';
  }

  /* ---------- 操作の振り分け ---------- */

  const actions = {
    nav() { location.hash = onCalendar() ? '#/' : '#/calendar'; },
    settings: openSettings,
    'settings-close'() { $('#settings').close(); },
    'cal-connect': connectCalendar,
    'clear-orphans'(el) {
      const day = el.dataset.day;
      const snap = S.snapshot();
      orphanBlockIds(day).forEach(blockId => {
        S.tasks(day, blockId).slice().forEach(t => S.remove({ kind: 'work', day, blockId, id: t.id }));
      });
      refresh();
      toast('予定が見つからない付箋を削除しました', snap);
    },
    'cal-disconnect'() {
      Object.assign(state.settings, { calendarUrl: '', calendarKey: '' });
      S.commit('settings');
      WB.sync.disable();
      ui.events = {};
      renderStatus();
      openSettings();
      refresh();
    },
    'sync-enable': enableSync,
    async 'sync-now'() {
      $('#sync-msg').textContent = '同期しています…';
      await WB.sync.push();
      await WB.sync.pull();
      if ($('#settings').open) openSettings();
    },
    'sync-disable'() {
      WB.sync.disable();
      openSettings();
    },
    tab(el) { ui.tab = el.dataset.tab; refresh(); },

    add(el) {
      const { kind, day, block } = el.dataset;
      if (kind === 'work') {
        ui.adding = { kind, day, blockId: block };
        openStrip(block);
      } else if (kind === 'life') {
        ui.adding = { kind, band: ui.peek || T.bandAt(new Date(), state.settings) };
      } else {
        ui.adding = { kind };
      }
      refresh();
    },
    edit(el) { openSheet(refFrom(el)); },
    'toggle-work'(el) {
      const ref = refFrom(el);
      S.toggleWork(ref, blockTitle(ref.day, ref.blockId));
      refresh();
    },
    'toggle-life'(el) {
      const ref = refFrom(el);
      S.toggleLife(today(), S.find(ref), BAND_LABEL[ref.band]);
      refresh();
    },
    'hold-to-today'(el) { openSheet(refFrom(el), 'pick', today()); },
    'toggle-strip'(el) {
      const strip = el.closest('.strip');
      const id = strip.dataset.block;
      if (strip.classList.contains('is-collapsed')) openStrip(id);
      else ui.expanded.delete(id);
      refresh();
    },

    'peek-open'() {
      const current = T.bandAt(new Date(), state.settings);
      ui.peek = BANDS[(BANDS.indexOf(current) + 1) % 3];
      ui.peekUntil = Date.now() + PEEK_MS;
      refresh();
    },
    'peek-band'(el) {
      ui.peek = el.dataset.band;
      ui.peekUntil = Date.now() + PEEK_MS;
      refresh();
    },
    'peek-close'() { ui.peek = null; refresh(); },

    'timer-start'() {
      unlockAudio();
      Object.assign(state.timer, { phase: 'focus', endsAt: Date.now() + FOCUS_MS, pausedLeft: null });
      S.commit('timer');
      renderTimer();
    },
    'timer-pause'() {
      state.timer.pausedLeft = timerLeft();
      S.commit('timer');
      renderTimer();
    },
    'timer-resume'() {
      state.timer.endsAt = Date.now() + state.timer.pausedLeft;
      state.timer.pausedLeft = null;
      S.commit('timer');
      renderTimer();
    },
    'timer-stop'() {
      Object.assign(state.timer, { phase: 'idle', endsAt: null, pausedLeft: null });
      S.commit('timer');
      renderTimer();
    },

    'sheet-close': closeSheet,
    'sheet-back'() { ui.sheet.mode = 'edit'; renderSheet(); },
    'sheet-up'() { shiftFromSheet(-1); },
    'sheet-down'() { shiftFromSheet(1); },
    'sheet-pin'() {
      const item = S.find(ui.sheet.ref);
      S.update(ui.sheet.ref, { pinned: !item.pinned });
      refresh();
      renderSheet();
    },
    'sheet-band'(el) {
      const ref = ui.sheet.ref;
      const band = el.dataset.band;
      if (band === ref.band) return;
      const snap = S.snapshot();
      S.transfer(ref, { kind: 'life', band }, ref.id);
      closeSheet();
      refresh();
      toast(`${BAND_LABEL[band]}へ移しました`, snap);
    },
    'sheet-repeat'() {
      const ref = ui.sheet.ref;
      const snap = S.snapshot();
      const title = blockTitle(ref.day, ref.blockId);
      S.makeRepeat(ref, title);
      refresh();
      renderSheet();
      toast(`予定「${title}」がある日に毎回出します`, snap);
    },
    'sheet-stop-repeat'() {
      const snap = S.snapshot();
      S.stopRepeat(ui.sheet.ref, today());
      refresh();
      renderSheet();
      toast('くり返しをやめました', snap);
    },
    'sheet-pick-today'() {
      ui.sheet.mode = 'pick';
      ui.sheet.pickDay = today();
      renderSheet();
    },
    'sheet-pick-same'() {
      ui.sheet.mode = 'pick';
      ui.sheet.pickDay = ui.sheet.ref.day;
      renderSheet();
    },
    'pick-block'(el) { moveToBlock(ui.sheet.ref, ui.sheet.pickDay, el.dataset.block); },
    'sheet-to-hold'() {
      const ref = ui.sheet.ref;
      const snap = S.snapshot();
      withFlip(() => {
        S.transfer(ref, { kind: 'hold' }, ref.id);
        refresh();
      });
      closeSheet();
      toast('保留へ移しました', snap);
    },
    'sheet-delete'() {
      const snap = S.snapshot();
      const { ref } = ui.sheet;
      S.remove(ref);
      closeSheet();
      refresh();
      toast('削除しました', snap);
    },
    undo() {
      if (!ui.undo) return;
      S.restore(ui.undo);
      applyTheme();
      $('#toast').hidden = true;
      ui.undo = null;
      refresh();
    },
    'set-theme'(el) {
      state.settings.theme = el.dataset.themeValue;
      S.commit('settings');
      applyTheme();
      openSettings();
    },
  };

  function shiftFromSheet(delta) {
    withFlip(() => {
      S.shift(ui.sheet.ref, delta, today());
      refresh();
    });
    renderSheet();
  }

  // 追加入力の確定。Enter でも外をタップしても、1枚保存して閉じる。
  function commitAdd(input, fromEnter) {
    const target = ui.adding;
    if (!target) return;
    const text = input.value.trim();
    ui.adding = null;
    if (text) S.add(target, text);
    if (fromEnter) {
      ui.skipBlur = true;
      refresh();
      ui.skipBlur = false;
    } else {
      // 外のボタンをタップした操作を消さないよう、描き直しを少し遅らせる
      setTimeout(() => { if (!ui.adding) refresh(); }, 200);
    }
  }

  function bindEvents() {
    document.addEventListener('click', e => {
      const el = e.target.closest('[data-act]');
      if (!el || ui.justDragged) return;
      const handler = actions[el.dataset.act];
      if (handler) handler(el, e);
    });

    document.addEventListener('keydown', e => {
      if (e.target.matches('.add-input')) {
        // 日本語変換の確定 Enter では追加しない
        if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
          e.preventDefault();
          commitAdd(e.target, true);
        } else if (e.key === 'Escape') {
          e.target.value = '';
          e.target.blur();
        }
      } else if (e.key === 'Enter' && e.target.matches('[role="button"]')) {
        e.target.click();
      }
    });

    document.addEventListener('focusout', e => {
      if (e.target.matches('.add-input') && !ui.skipBlur) commitAdd(e.target, false);
      // iOS でキーボードを閉じたあと画面がずれたままになるのを戻す
      if (e.target.matches('input, textarea')) window.scrollTo(0, 0);
    });

    document.addEventListener('pointerdown', e => {
      unlockAudio();
      if (ui.peek) ui.peekUntil = Date.now() + PEEK_MS;
      // iOS は余白のタップでは入力を閉じないので明示的に閉じる
      if (ui.adding && !e.target.closest('.add-input') && document.activeElement && document.activeElement.matches('.add-input')) {
        document.activeElement.blur();
      }
    });

    document.addEventListener('input', e => {
      if (e.target.id === 'sheet-text') {
        // 空欄は保存せず、直前の内容を残す
        const text = e.target.value.replace(/\s*\n\s*/g, ' ').trim();
        if (text) {
          S.update(ui.sheet.ref, { text }, today());
          refresh();
        }
      } else if (e.target.id === 'sheet-review') {
        S.update(ui.sheet.ref, { reviewDate: e.target.value || null });
        refresh();
      } else if (e.target.dataset.setting) {
        applyTimeSettings();
      }
    });

    document.addEventListener('change', e => {
      if (e.target.dataset.setting) applyTimeSettings();
      if (e.target.id === 'setting-chime') {
        state.settings.chime = e.target.checked;
        S.commit('settings');
      }
    });

    ['sheet', 'settings'].forEach(id => {
      const dlg = document.getElementById(id);
      dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    });
    // 閉じた設定画面に鍵を残さない
    $('#settings').addEventListener('close', () => { $('#settings').innerHTML = ''; });

    window.addEventListener('hashchange', refresh);
    window.addEventListener('resize', () => {
      if (onCalendar()) return;
      fitTimeline();
      fitHolds();
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
    window.addEventListener('pageshow', tick);
    window.addEventListener('focus', tick);
  }

  function applyTimeSettings() {
    const read = key => $(`[data-setting="${key}"]`).value;
    const [am, pm, eve] = ['amStart', 'pmStart', 'eveStart'].map(read);
    const msg = $('#settings-msg');
    if (!am || !pm || !eve || !(T.toMin(am) < T.toMin(pm) && T.toMin(pm) < T.toMin(eve))) {
      msg.textContent = '午前 → 午後 → 夕方・夜 の順になるように入力してください（この変更は保存していません）。';
      msg.classList.add('is-error');
      return;
    }
    msg.textContent = '午前の開始時刻で1日が切り替わり、生活のチェックがリセットされます。';
    msg.classList.remove('is-error');
    Object.assign(state.settings, { amStart: am, pmStart: pm, eveStart: eve });
    S.commit('settings');
    ui.lastSig = '';
    tick();
  }

  async function boot() {
    const firstRun = await S.init();
    S.onSaveError = () => toast('保存できませんでした。ブラウザの設定を確認してください');
    S.onExternalChange = () => { if (!ui.dragging && !ui.adding) refresh(); };
    applyTheme();
    WB.sync.onRemoteChange = () => {
      if (ui.dragging || ui.adding) ui.pendingRemote = true;
      else refresh();
    };
    WB.sync.onConflict = () => toast('もう一方の端末でも同じところが変わっていたため、この端末の内容で上書きしました');
    WB.sync.onStatus = () => {
      renderStatus();
      const msg = $('#sync-msg');
      if (msg && $('#settings').open) msg.textContent = syncStatusText();
    };
    WB.sync.start();
    // 共有中なら新しい分を先に受け取ってから表示する（くり返し付箋を二重に貼らないため）
    if (WB.sync.enabled) await Promise.race([WB.sync.pull(), new Promise(resolve => setTimeout(resolve, 4000))]);
    // 接続済みなら前回の予定で先に表示し、裏で取り直す
    const cached = WB.calendarProvider.connected ? WB.calendarProvider.cached(today(), today()) : {};
    if (cached[today()]) Object.assign(ui.events, cached);
    else await loadEvents(today(), today());
    if (firstRun) {
      (ui.events[today()] || []).forEach(ev => {
        (ev.sample || []).forEach(text => S.add({ kind: 'work', day: today(), blockId: ev.id }, text));
      });
    }
    bindEvents();
    renderStatus();
    renderClock();
    ui.lastSig = signature();
    refresh();
    if (cached[today()]) reloadEvents();
    setInterval(tick, 1000);
  }

  WB.ui = { $, esc, ui, actions, today, blocksFor, stripHTML, refresh };

  document.addEventListener('DOMContentLoaded', boot);
})(window.WB);
