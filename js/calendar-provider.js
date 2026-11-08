// 予定の取得元（読み取り専用）。設定に中継URLと鍵があれば Google カレンダー、なければサンプル。
//   getEvents(fromKey, toKey) → {'YYYY-MM-DD': [{id, title, start:'09:00', end:'10:00', kind:'work'|'fixed'}]}
// id は Google Calendar の event.id（繰り返し予定は回ごとに別のID）で、付箋との紐づけに使う。
// カレンダーへは書き込まない。中継は gas/calendar-relay.js（Apps Script の Web アプリ）。
window.WB = window.WB || {};
(function (WB) {
  'use strict';

  const CACHE_KEY = 'wb.v1.eventCache';
  const CACHE_DAYS = 60;

  const FOCUS = [
    ['09:00', '10:00', '出品作業', 'work', ['写真と状態の確認', '出品登録']],
    ['10:00', '11:00', '営業・発信', 'work', ['コメント・DMによる接点づくり', '投稿の作成']],
    ['11:00', '12:00', '発送と問い合わせ', 'work', ['発送指示の確認']],
  ];
  const AFTERNOON = [
    ['13:00', '15:00', '業務改善', 'work', ['シートの入力項目を1つ減らす']],
    ['15:00', '16:00', 'AI自動化', 'work', ['発送タスクの動作確認']],
  ];
  const NIGHT = [['20:00', '21:00', '学習', 'work', ['教材を1章進める']]];

  const WEEK = [
    [['10:00', '11:00', '週の振り返り', 'work', ['来週の作業時間を決める']]], // 日
    [...FOCUS, ...AFTERNOON, ...NIGHT],                                     // 月
    [...FOCUS, ['13:00', '14:00', '打ち合わせ', 'fixed', []], ['14:00', '16:00', '業務改善', 'work', ['シートの入力項目を1つ減らす']], ...NIGHT], // 火
    [...FOCUS, ...AFTERNOON, ...NIGHT],                                     // 水
    [...FOCUS, ...AFTERNOON, ['16:00', '17:00', 'スタッフ定例', 'fixed', []], ...NIGHT], // 木
    [...FOCUS, ...AFTERNOON, ...NIGHT],                                     // 金
    [['10:00', '12:00', '出品作業', 'work', ['写真と状態の確認']], ['14:00', '15:00', '学習', 'work', ['教材を1章進める']]], // 土
  ];

  function eachDay(fromKey, toKey, fn) {
    for (let day = fromKey; day <= toKey; day = WB.time.addDays(day, 1)) fn(day);
  }

  function sampleEvents(fromKey, toKey) {
    const result = {};
    eachDay(fromKey, toKey, day => {
      const weekday = WB.time.parseDay(day).getDay();
      result[day] = WEEK[weekday].map(([start, end, title, kind, sample]) => ({
        id: `mock-${day}-${start.replace(':', '')}`,
        title,
        start,
        end,
        kind,
        sample,
      }));
    });
    return result;
  }

  // 取得に失敗したときに前回の予定を出すための控え（この端末の中だけ）
  function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch (e) { return {}; }
  }

  function writeCache(days) {
    const cache = { ...readCache(), ...days };
    const keys = Object.keys(cache).sort();
    keys.slice(0, Math.max(0, keys.length - CACHE_DAYS)).forEach(k => { delete cache[k]; });
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (e) {}
  }

  const P = {
    status: 'sample',   // sample: 未接続 / ok: 取得できた / error: 取得できず前回の予定を表示
    updatedAt: null,
    error: '',

    get connected() {
      const s = WB.store.state.settings;
      return Boolean(s.calendarUrl && s.calendarKey);
    },

    // 前回取得した予定（起動直後に先に表示する用）。控えがない日は含めない。
    cached(fromKey, toKey) {
      const cache = readCache();
      const result = {};
      eachDay(fromKey, toKey, day => { if (cache[day]) result[day] = cache[day]; });
      return result;
    },

    async getEvents(fromKey, toKey) {
      if (!P.connected) {
        P.status = 'sample';
        return sampleEvents(fromKey, toKey);
      }
      const days = {};
      try {
        const data = await P.fetchRange(WB.store.state.settings, fromKey, toKey);
        eachDay(fromKey, toKey, day => { days[day] = data.days[day] || []; });
        writeCache(days);
        P.status = 'ok';
        P.updatedAt = new Date();
        P.error = '';
      } catch (e) {
        const cache = readCache();
        eachDay(fromKey, toKey, day => { days[day] = cache[day] || []; });
        P.status = 'error';
        P.error = e.message;
      }
      return days;
    },

    // 接続の確認にも使う。失敗したら理由を日本語の Error で返す。
    async fetchRange({ calendarUrl, calendarKey }, fromKey, toKey) {
      const url = new URL(calendarUrl);
      url.searchParams.set('key', calendarKey);
      url.searchParams.set('from', fromKey);
      url.searchParams.set('to', toKey);
      let res;
      try {
        res = await fetch(url.toString(), { cache: 'no-store' });
      } catch (e) {
        throw new Error('中継に接続できませんでした');
      }
      if (!res.ok) throw new Error(`中継がエラーを返しました（${res.status}）`);
      let data;
      try {
        data = await res.json();
      } catch (e) {
        throw new Error('中継の応答を読めませんでした。公開の設定を確認してください');
      }
      if (!data.ok) throw new Error(data.error === 'unauthorized' ? '鍵が一致しません' : '予定を取得できませんでした');
      return data;
    },
  };

  WB.calendarProvider = P;
})(window.WB);
