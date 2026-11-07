// 予定の取得元（読み取り専用）。第2段階では同じ形の Google Calendar 版に差し替える。
//   getEvents(fromKey, toKey) → {'YYYY-MM-DD': [{id, title, start:'09:00', end:'10:00', kind:'work'|'fixed'}]}
// id は Google Calendar の event.id に相当し、付箋との紐づけに使う。付箋を動かしても予定には書き込まない。
window.WB = window.WB || {};
(function (WB) {
  'use strict';

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

  WB.calendarProvider = {
    connected: false,

    async getEvents(fromKey, toKey) {
      const T = WB.time;
      const result = {};
      for (let day = fromKey; day <= toKey; day = T.addDays(day, 1)) {
        const weekday = T.parseDay(day).getDay();
        result[day] = WEEK[weekday].map(([start, end, title, kind, sample]) => ({
          id: `mock-${day}-${start.replace(':', '')}`,
          title,
          start,
          end,
          kind,
          sample,
        }));
      }
      return result;
    },
  };
})(window.WB);
