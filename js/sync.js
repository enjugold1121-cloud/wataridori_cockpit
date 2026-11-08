// PCとiPadで付箋などを共有する。保存先は中継（gas/sync-store.js）経由の Google ドライブ。
// 変更は少し待ってまとめて送り、30秒ごと・画面に戻ったときに新しい分を受け取る。
// 同じ単位をほぼ同時に2台で変えたときは、後から保存したほうが残る（そのとき onConflict で知らせる）。
// 設定とタイマーは端末ごとのままにする。
window.WB = window.WB || {};
(function (WB) {
  'use strict';

  const META_KEY = 'wb.v1.syncMeta';
  const PUSH_DELAY_MS = 1500;
  const PULL_INTERVAL_MS = 30 * 1000;
  const RETRY_MS = 30 * 1000;
  const WHOLE = ['holds', 'workRepeats', 'repeatLog', 'lifeTemplate', 'history'];
  const BY_DAY = ['work', 'lifeLog'];
  const EMPTY = { holds: [], workRepeats: [], repeatLog: {}, lifeTemplate: { am: [], pm: [], eve: [] }, history: [] };

  const S = WB.store;
  const state = S.state;
  let meta = loadMeta();
  let pushTimer = null;
  let pushing = false;
  let pulling = false;

  function loadMeta() {
    const base = { enabled: false, lastServerRev: 0, revs: {}, hashes: {}, lastSyncAt: null, error: '' };
    try { return { ...base, ...JSON.parse(localStorage.getItem(META_KEY)) }; } catch (e) { return base; }
  }

  function saveMeta() {
    try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch (e) {}
  }

  // 変化の有無だけ分かればよいので、JSON の短い指紋で比べる
  function hash(value) {
    const s = JSON.stringify(value === undefined ? null : value);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return `${(h >>> 0).toString(36)}:${s.length}`;
  }

  function currentUnits() {
    const units = {};
    WHOLE.forEach(name => { units[name] = state[name]; });
    BY_DAY.forEach(name => Object.keys(state[name]).forEach(day => { units[`${name}/${day}`] = state[name][day]; }));
    return units;
  }

  // 前回送った・受け取った内容から変わった単位。消えた日は空として送る。
  function dirtyUnits() {
    const units = currentUnits();
    const keys = new Set([...Object.keys(units), ...Object.keys(meta.hashes)]);
    const dirty = [];
    keys.forEach(key => {
      const value = key in units ? units[key] : {};
      if (hash(value) !== meta.hashes[key]) dirty.push({ key, value });
    });
    return dirty;
  }

  function applyUnit(key, value) {
    const [name, day] = key.split('/');
    if (day) {
      if (value && Object.keys(value).length) state[name][day] = value;
      else delete state[name][day];
    } else {
      state[name] = value === null || value === undefined ? JSON.parse(JSON.stringify(EMPTY[name])) : value;
    }
    return name;
  }

  async function call(method, params, body) {
    const { calendarUrl, calendarKey } = state.settings;
    const url = new URL(calendarUrl);
    let res;
    try {
      if (method === 'GET') {
        url.searchParams.set('key', calendarKey);
        Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
        res = await fetch(url.toString(), { cache: 'no-store' });
      } else {
        // 文字列で送ると text/plain になり、事前確認なしで中継に届く
        res = await fetch(url.toString(), { method: 'POST', body: JSON.stringify({ key: calendarKey, ...body }) });
      }
    } catch (e) {
      throw new Error('中継に接続できませんでした');
    }
    if (!res.ok) throw new Error(`中継がエラーを返しました（${res.status}）`);
    let data;
    try {
      data = await res.json();
    } catch (e) {
      throw new Error('中継の応答を読めませんでした。デプロイを新しい版に更新したか確認してください');
    }
    if (!data.ok) throw new Error(data.error === 'unauthorized' ? '鍵が一致しません' : (data.error || '共有に失敗しました'));
    return data;
  }

  function succeeded() {
    meta.error = '';
    meta.lastSyncAt = new Date().toISOString();
    saveMeta();
    Y.onStatus();
  }

  function failed(e) {
    meta.error = e.message;
    saveMeta();
    Y.onStatus();
  }

  async function pull() {
    if (!meta.enabled || pulling || !S.state.settings.calendarUrl) return;
    pulling = true;
    try {
      const data = await call('GET', { action: 'pull', since: meta.lastServerRev });
      const dirty = new Set(dirtyUnits().map(u => u.key));
      const units = currentUnits();
      const changed = new Set();
      Object.entries(data.units).forEach(([key, unit]) => {
        if (dirty.has(key)) return; // この端末の未送信の変更を優先し、次の送信で上書きする
        meta.revs[key] = unit.rev;
        meta.hashes[key] = hash(unit.value);
        const local = key in units ? units[key] : (key.includes('/') ? {} : undefined);
        if (hash(local) === meta.hashes[key]) return;
        changed.add(applyUnit(key, unit.value));
      });
      meta.lastServerRev = data.serverRev;
      if (changed.size) {
        S.commit(...changed);
        Y.onRemoteChange();
      }
      succeeded();
    } catch (e) {
      failed(e);
    } finally {
      pulling = false;
    }
  }

  async function push() {
    if (!meta.enabled || !S.state.settings.calendarUrl) return;
    if (pushing) {
      schedulePush();
      return;
    }
    const dirty = dirtyUnits();
    if (!dirty.length) return;
    pushing = true;
    try {
      const data = await call('POST', null, {
        action: 'push',
        units: dirty.map(u => ({ key: u.key, value: u.value, baseRev: meta.revs[u.key] || 0 })),
      });
      dirty.forEach(u => {
        meta.hashes[u.key] = hash(u.value);
        meta.revs[u.key] = data.revs[u.key];
      });
      succeeded();
      if (data.conflicts && data.conflicts.length) Y.onConflict();
    } catch (e) {
      failed(e);
      clearTimeout(pushTimer);
      pushTimer = setTimeout(push, RETRY_MS);
    } finally {
      pushing = false;
    }
  }

  function schedulePush() {
    if (!meta.enabled) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, PUSH_DELAY_MS);
  }

  const Y = {
    onRemoteChange() {},
    onConflict() {},
    onStatus() {},

    get enabled() { return meta.enabled; },
    get error() { return meta.error; },
    get lastSyncAt() { return meta.lastSyncAt ? new Date(meta.lastSyncAt) : null; },

    pull,
    push,

    // 共有を始める。共有データがまだなければこの端末の内容を基準にし、あれば確認のうえ共有データに置き換える。
    async enable(confirmReplace) {
      const data = await call('GET', { action: 'pull', since: 0 });
      const serverKeys = Object.keys(data.units);
      if (!serverKeys.length) {
        meta = { ...meta, enabled: true, lastServerRev: data.serverRev, revs: {}, hashes: {}, error: '' };
        saveMeta();
        await push();
        if (meta.error) {
          const message = meta.error;
          Y.disable();
          throw new Error(message);
        }
        return 'uploaded';
      }
      if (!confirmReplace()) return 'cancelled';
      // 置き換える前の内容は、この端末に控えとして残す
      try { localStorage.setItem(`wb.v1.backup.${Date.now()}`, S.snapshot()); } catch (e) {}
      WHOLE.forEach(name => { state[name] = JSON.parse(JSON.stringify(EMPTY[name])); });
      BY_DAY.forEach(name => { state[name] = {}; });
      meta = { ...meta, enabled: true, lastServerRev: data.serverRev, revs: {}, hashes: {}, error: '' };
      serverKeys.forEach(key => {
        applyUnit(key, data.units[key].value);
        meta.revs[key] = data.units[key].rev;
        meta.hashes[key] = hash(data.units[key].value);
      });
      saveMeta();
      S.commit(...WHOLE, ...BY_DAY);
      succeeded();
      return 'downloaded';
    },

    disable() {
      clearTimeout(pushTimer);
      meta = { ...meta, enabled: false, error: '' };
      saveMeta();
      Y.onStatus();
    },

    start() {
      S.onCommit = names => {
        if (names.some(n => WHOLE.includes(n) || BY_DAY.includes(n))) schedulePush();
      };
      setInterval(() => { if (!document.hidden) pull(); }, PULL_INTERVAL_MS);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(); });
      // 閉じる直前に未送信の変更があれば送っておく
      window.addEventListener('pagehide', () => { if (meta.enabled && dirtyUnits().length) push(); });
    },
  };

  WB.sync = Y;
})(window.WB);
