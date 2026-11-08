/**
 * 渡り鳥の操縦席：Googleカレンダーの予定を読み取り専用で返す中継（Webアプリ）。
 * 付箋の共有（action=pull と doPost）は sync-store.js。
 *
 * - 返すのは予定のID・名前・開始と終了の時刻だけ。説明・場所・参加者は返さない
 * - スクリプトプロパティ ACCESS_KEY と一致する鍵がない呼び出しには何も返さない
 * - 読む予定表はスクリプトプロパティ CALENDAR_IDS（カンマ区切り）。未設定ならメインのカレンダー
 * - 終日の予定は今は返さない
 */

const MAX_RANGE_DAYS = 42;

function doGet(e) {
  const params = (e && e.parameter) || {};
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('ACCESS_KEY');
  if (!key || params.key !== key) return json_({ ok: false, error: 'unauthorized' });
  if (params.action === 'pull') {
    try {
      return json_(pullUnits_(props, params));
    } catch (err) {
      return json_({ ok: false, error: String(err && err.message || err) });
    }
  }

  const from = params.from;
  const to = params.to;
  if (!isDayKey_(from) || !isDayKey_(to) || from > to) return json_({ ok: false, error: 'bad range' });

  const tz = Session.getScriptTimeZone();
  const timeMin = startOfDay_(from, tz);
  const timeMax = new Date(startOfDay_(to, tz).getTime() + 24 * 3600 * 1000);
  if ((timeMax - timeMin) / (24 * 3600 * 1000) > MAX_RANGE_DAYS) return json_({ ok: false, error: 'bad range' });

  const days = {};
  const seen = {};
  calendarIds_(props).forEach(calendarId => {
    let pageToken;
    do {
      const res = Calendar.Events.list(calendarId, {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 250,
        pageToken: pageToken,
      });
      (res.items || []).forEach(item => {
        if (item.status === 'cancelled' || !item.start || !item.start.dateTime || seen[item.id]) return;
        seen[item.id] = true;
        const start = new Date(item.start.dateTime);
        const end = new Date(item.end.dateTime);
        const day = Utilities.formatDate(start, tz, 'yyyy-MM-dd');
        const endDay = Utilities.formatDate(end, tz, 'yyyy-MM-dd');
        (days[day] = days[day] || []).push({
          id: item.id,
          title: item.summary || '（無題の予定）',
          start: Utilities.formatDate(start, tz, 'HH:mm'),
          // 日をまたぐ予定は、その日の終わりまでとして扱う
          end: endDay > day ? '24:00' : Utilities.formatDate(end, tz, 'HH:mm'),
          kind: 'work',
        });
      });
      pageToken = res.nextPageToken;
    } while (pageToken);
  });

  Object.keys(days).forEach(day => days[day].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)));
  return json_({ ok: true, timeZone: tz, days: days });
}

/**
 * 最初に1回だけ実行する。実行ログに出た鍵を操縦席の設定に入れる。
 * もう一度実行すると鍵が変わり、古い鍵は使えなくなる。
 */
function setupKey() {
  const key = Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('ACCESS_KEY', key);
  Logger.log('操縦席の設定に入れる鍵: ' + key);
}

/** 今日の予定が読めるか確かめる。件数と時刻だけをログに出す。 */
function checkToday() {
  const tz = Session.getScriptTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const key = PropertiesService.getScriptProperties().getProperty('ACCESS_KEY');
  const result = JSON.parse(doGet({ parameter: { key: key, from: today, to: today } }).getContent());
  if (!result.ok) {
    Logger.log('読めませんでした: ' + result.error + '（先に setupKey を実行してください）');
    return;
  }
  const events = result.days[today] || [];
  Logger.log(today + ' の予定: ' + events.length + '件');
  events.forEach(ev => Logger.log(ev.start + '〜' + ev.end));
}

function calendarIds_(props) {
  return (props.getProperty('CALENDAR_IDS') || 'primary')
    .split(',')
    .map(id => id.trim())
    .filter(id => id);
}

function isDayKey_(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function startOfDay_(dayKey, tz) {
  const offset = Utilities.formatDate(new Date(dayKey + 'T12:00:00Z'), tz, 'XXX');
  return new Date(dayKey + 'T00:00:00' + offset);
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
