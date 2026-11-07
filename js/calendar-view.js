// 全体カレンダー（別ページ）。週表示が基本で、日表示へ切替可能。保留と生活の付箋は出さない。
(function (WB) {
  'use strict';

  const T = WB.time, S = WB.store;
  const { $, esc, ui, actions, today, blocksFor, stripHTML } = WB.ui;

  const cal = { view: 'week', anchor: null, selected: null };

  function days() {
    if (!cal.anchor) {
      cal.anchor = today();
      cal.selected = today();
    }
    if (cal.view === 'day') return [cal.anchor];
    const start = T.weekStart(cal.anchor);
    return Array.from({ length: 7 }, (_, i) => T.addDays(start, i));
  }

  function hourRange(list) {
    let startH = 8;
    let endH = 21;
    list.forEach(day => (ui.events[day] || []).forEach(ev => {
      startH = Math.min(startH, Math.floor(T.toMin(ev.start) / 60));
      endH = Math.max(endH, Math.ceil(T.toMin(ev.end) / 60));
    }));
    return { startH, endH };
  }

  function dayHeadHTML(day, isToday) {
    const tasks = Object.values(S.state.work[day] || {}).flat();
    const done = tasks.filter(t => t.done).length;
    const open = tasks.length - done;
    let note = '';
    if (tasks.length) note = day < today() && open ? `未完了${open}` : `${done}/${tasks.length}`;
    return `<button class="cal-dayhead${isToday ? ' is-today' : ''}${day === cal.selected ? ' is-selected' : ''}" data-act="cal-select" data-day="${day}">
      <span class="cal-dow">${T.weekdayLabel(day)}</span>
      <span class="cal-date">${T.shortDate(day)}</span>
      <span class="cal-note">${note}</span>
    </button>`;
  }

  function eventHTML(day, ev, range) {
    const span = (range.endH - range.startH) * 60;
    const top = (T.toMin(ev.start) - range.startH * 60) / span * 100;
    const height = (T.toMin(ev.end) - T.toMin(ev.start)) / span * 100;
    const tasks = S.tasks(day, ev.id);
    const done = tasks.filter(t => t.done).length;
    const taskLines = cal.view === 'day' && tasks.length
      ? `<ul class="cal-ev-tasks">${tasks.map(t => `<li class="${t.done ? 'is-done' : ''}">${esc(t.text)}</li>`).join('')}</ul>`
      : '';
    const timeText = cal.view === 'day' ? `${ev.start}〜${ev.end}` : ev.start;
    return `<div class="cal-ev kind-${ev.kind}" style="top:${top}%;height:${height}%" data-act="cal-select" data-day="${day}" role="button" tabindex="0">
      <div class="cal-ev-head">
        <span class="cal-ev-title">${esc(ev.title)}</span>
        <span class="cal-ev-meta">${timeText}${tasks.length ? ` · ${done}/${tasks.length}` : ''}</span>
      </div>
      ${taskLines}
    </div>`;
  }

  function historyHTML(day) {
    const items = S.historyOf(day);
    if (!items.length) return '<p class="cal-empty">完了の記録はまだありません</p>';
    const work = items.filter(h => h.kind === 'work').length;
    const life = items.length - work;
    return `<p class="cal-history-sum">仕事 ${work}件 ・ 生活 ${life}件</p>
      <ul class="cal-history-list">${items.map(h => `<li>
        <span class="h-time">${T.clock(new Date(h.doneAt))}</span>
        <span class="h-text">${esc(h.text)}</span>
        <span class="h-context">${esc(h.context || '')}</span>
      </li>`).join('')}</ul>`;
  }

  function rangeLabel(list) {
    if (cal.view === 'day') return T.dayLabel(list[0]);
    return `${T.dayLabel(list[0])} 〜 ${T.dayLabel(list[list.length - 1])}`;
  }

  function render() {
    const list = days();
    const todayKey = today();
    const range = hourRange(list);
    const hours = range.endH - range.startH;
    const nowMin = T.opMinutes(new Date(), S.state.settings);
    const nowTop = (nowMin - range.startH * 60) / (hours * 60) * 100;

    const hourLabels = Array.from({ length: hours }, (_, i) =>
      `<span style="top:${i / hours * 100}%">${T.pad(range.startH + i)}:00</span>`).join('');

    const columns = list.map(day => `<div class="cal-col${day === todayKey ? ' is-today' : ''}${day === cal.selected ? ' is-selected' : ''}">
      ${(ui.events[day] || []).map(ev => eventHTML(day, ev, range)).join('')}
      ${day === todayKey && nowTop >= 0 && nowTop <= 100 ? `<div class="cal-now" style="top:${nowTop}%"></div>` : ''}
    </div>`).join('');

    const selected = cal.selected;
    $('#page-calendar').innerHTML = `
      <div class="cal-toolbar">
        <div class="segmented">
          <button class="seg${cal.view === 'week' ? ' is-on' : ''}" data-act="cal-view" data-view="week">週</button>
          <button class="seg${cal.view === 'day' ? ' is-on' : ''}" data-act="cal-view" data-view="day">日</button>
        </div>
        <div class="btn-group">
          <button class="btn" data-act="cal-move" data-dir="-1" aria-label="前へ">‹</button>
          <button class="btn" data-act="cal-today">今日</button>
          <button class="btn" data-act="cal-move" data-dir="1" aria-label="次へ">›</button>
        </div>
        <strong class="cal-range">${rangeLabel(list)}</strong>
      </div>
      <div class="cal-layout">
        <div class="cal-grid${cal.view === 'day' ? ' is-day' : ''}" style="--cols:${list.length};--hours:${hours}">
          <div class="cal-heads">
            <div class="cal-corner"></div>
            ${list.map(day => dayHeadHTML(day, day === todayKey)).join('')}
          </div>
          <div class="cal-body">
            <div class="cal-hours">${hourLabels}</div>
            <div class="cal-cols">${columns}</div>
          </div>
        </div>
        <aside class="cal-panel" aria-label="選択した日のタスク">
          <header class="cal-panel-head">
            <h2>${T.dayLabel(selected)}</h2>
            ${selected === todayKey ? '<span class="now-badge">今日</span>' : ''}
          </header>
          <div class="cal-panel-body">
            ${blocksFor(selected).map(b => stripHTML(selected, b, { panel: true })).join('')}
            <section class="cal-history">
              <h3>完了履歴</h3>
              ${historyHTML(selected)}
            </section>
          </div>
        </aside>
      </div>`;
  }

  Object.assign(actions, {
    'cal-view'(el) {
      cal.view = el.dataset.view;
      cal.anchor = cal.selected;
      WB.ui.refresh();
    },
    'cal-select'(el) {
      cal.selected = el.dataset.day;
      WB.ui.refresh();
    },
    'cal-move'(el) {
      const step = Number(el.dataset.dir) * (cal.view === 'week' ? 7 : 1);
      cal.anchor = T.addDays(cal.anchor, step);
      cal.selected = T.addDays(cal.selected, step);
      WB.ui.refresh();
    },
    'cal-today'() {
      cal.anchor = today();
      cal.selected = today();
      WB.ui.refresh();
    },
  });

  WB.calendarView = { render, days };
})(window.WB);
