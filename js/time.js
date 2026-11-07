// 日付と時間帯の計算。日付キーは端末のローカル時刻で作る（toISOStringはUTCになるので使わない）。
window.WB = window.WB || {};
(function (WB) {
  'use strict';

  const pad = n => String(n).padStart(2, '0');
  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

  const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseDay = key => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const addDays = (key, n) => {
    const d = parseDay(key);
    d.setDate(d.getDate() + n);
    return dayKey(d);
  };
  const toMin = hhmm => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  const minutesOf = d => d.getHours() * 60 + d.getMinutes();

  WB.time = {
    pad,
    dayKey,
    parseDay,
    addDays,
    toMin,
    minutesOf,

    // 運行日：午前の開始時刻（初期値05:00）で日付が切り替わる。深夜1時はまだ前日の夜として扱う。
    operatingDay(date, settings) {
      return minutesOf(date) < toMin(settings.amStart) ? addDays(dayKey(date), -1) : dayKey(date);
    },

    // 運行日の0時からの経過分。深夜は1440分以降の値になる。
    opMinutes(date, settings) {
      const m = minutesOf(date);
      return m < toMin(settings.amStart) ? m + 1440 : m;
    },

    bandAt(date, settings) {
      const m = minutesOf(date);
      if (m >= toMin(settings.amStart) && m < toMin(settings.pmStart)) return 'am';
      if (m >= toMin(settings.pmStart) && m < toMin(settings.eveStart)) return 'pm';
      return 'eve';
    },

    weekStart(key) {
      const day = parseDay(key).getDay();
      return addDays(key, day === 0 ? -6 : 1 - day);
    },

    weekdayLabel: key => WEEKDAYS[parseDay(key).getDay()],

    dayLabel(key) {
      const d = parseDay(key);
      return `${d.getMonth() + 1}月${d.getDate()}日(${WEEKDAYS[d.getDay()]})`;
    },

    shortDate(key) {
      const d = parseDay(key);
      return `${d.getMonth() + 1}/${d.getDate()}`;
    },

    clock: d => `${pad(d.getHours())}:${pad(d.getMinutes())}`,

    leftLabel(min) {
      if (min < 60) return `${min}分`;
      const rest = min % 60;
      return rest ? `${Math.floor(min / 60)}時間${rest}分` : `${min / 60}時間`;
    },
  };
})(window.WB);
