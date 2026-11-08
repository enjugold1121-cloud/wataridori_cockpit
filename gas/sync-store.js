/**
 * 渡り鳥の操縦席：PCとiPadで付箋などを共有するための保存先。
 *
 * - 保存先は Google ドライブのファイル1つ（wataridori-cockpit-data.json）。このスクリプトが作ったファイルだけを読み書きする
 * - データは「単位」ごとに版番号を持つ。保留・雛形などは1単位、仕事の付箋と生活の完了記録は1日1単位
 * - 同じ単位を2台がほぼ同時に保存したときは、後から保存したほうが残る。そのときは呼び出し元へ conflicts で知らせる
 */

const SYNC_FILE_NAME = 'wataridori-cockpit-data.json';
const SYNC_UNIT_PATTERN = /^(holds|workRepeats|repeatLog|lifeTemplate|history|(work|lifeLog)\/\d{4}-\d{2}-\d{2})$/;
const SYNC_MAX_BODY_CHARS = 5 * 1024 * 1024;

function doPost(e) {
  try {
    const contents = (e && e.postData && e.postData.contents) || '';
    if (contents.length > SYNC_MAX_BODY_CHARS) return json_({ ok: false, error: 'too large' });
    let body;
    try {
      body = JSON.parse(contents || '{}');
    } catch (err) {
      return json_({ ok: false, error: 'bad request' });
    }
    const props = PropertiesService.getScriptProperties();
    const key = props.getProperty('ACCESS_KEY');
    if (!key || body.key !== key) return json_({ ok: false, error: 'unauthorized' });
    if (body.action !== 'push' || !Array.isArray(body.units)) return json_({ ok: false, error: 'bad request' });
    return json_(pushUnits_(props, body.units));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function pushUnits_(props, units) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const doc = readSyncDoc_(props);
    const revs = {};
    const conflicts = [];
    const now = new Date().toISOString();
    units.forEach(unit => {
      if (!unit || !SYNC_UNIT_PATTERN.test(unit.key)) return;
      const current = doc.units[unit.key];
      if (current && current.rev > (Number(unit.baseRev) || 0)) conflicts.push(unit.key);
      doc.serverRev += 1;
      doc.units[unit.key] = { rev: doc.serverRev, value: unit.value === undefined ? null : unit.value, updatedAt: now };
      revs[unit.key] = doc.serverRev;
    });
    writeSyncDoc_(props, doc);
    return { ok: true, serverRev: doc.serverRev, revs: revs, conflicts: conflicts };
  } finally {
    lock.releaseLock();
  }
}

// since より新しい単位だけを返す（doGet の action=pull から呼ぶ）
function pullUnits_(props, params) {
  const since = Number(params.since) || 0;
  const doc = readSyncDoc_(props);
  const units = {};
  Object.keys(doc.units).forEach(key => {
    const unit = doc.units[key];
    if (unit.rev > since) units[key] = { rev: unit.rev, value: unit.value };
  });
  return { ok: true, serverRev: doc.serverRev, units: units };
}

/** 共有の保存先が読めるかを確かめる（権限の許可にも使う）。鍵は変えない。 */
function checkSync() {
  const props = PropertiesService.getScriptProperties();
  const doc = readSyncDoc_(props);
  Logger.log('共有データ: ' + Object.keys(doc.units).length + '単位・版 ' + doc.serverRev +
    (props.getProperty('SYNC_FILE_ID') ? '' : '（まだ保存されていません。最初の共有で作られます）'));
}

function readSyncDoc_(props) {
  const id = props.getProperty('SYNC_FILE_ID');
  if (!id) return { serverRev: 0, units: {} };
  const res = driveFetch_('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?alt=media', { method: 'get' });
  if (res.getResponseCode() !== 200) throw new Error('共有データを読めませんでした（' + res.getResponseCode() + '）');
  const doc = JSON.parse(res.getContentText() || '{}');
  return { serverRev: Number(doc.serverRev) || 0, units: doc.units || {} };
}

function writeSyncDoc_(props, doc) {
  let id = props.getProperty('SYNC_FILE_ID');
  if (!id) {
    const created = driveFetch_('https://www.googleapis.com/drive/v3/files', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ name: SYNC_FILE_NAME, mimeType: 'application/json' }),
    });
    if (created.getResponseCode() !== 200) throw new Error('共有データを作れませんでした（' + created.getResponseCode() + '）');
    id = JSON.parse(created.getContentText()).id;
    props.setProperty('SYNC_FILE_ID', id);
  }
  const res = driveFetch_('https://www.googleapis.com/upload/drive/v3/files/' + encodeURIComponent(id) + '?uploadType=media', {
    method: 'patch',
    contentType: 'application/json',
    payload: Utilities.newBlob(JSON.stringify({ serverRev: doc.serverRev, units: doc.units }), 'application/json').getBytes(),
  });
  if (res.getResponseCode() !== 200) throw new Error('共有データを保存できませんでした（' + res.getResponseCode() + '）');
}

function driveFetch_(url, options) {
  return UrlFetchApp.fetch(url, Object.assign({
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
  }, options));
}
