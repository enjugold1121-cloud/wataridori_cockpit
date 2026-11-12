// PCとiPadで付箋などを共有する。保存先は中継（gas/sync-store.js）経由の Google ドライブ。
// 変更は少し待ってまとめて送り、30秒ごと・画面に戻ったときに新しい分を受け取る。
// 送る前には必ず新しい分を受け取り、両方の端末の変更を1つにまとめてから送る（片方の変更で上書きしない）。
// まとめるときは前回そろえた内容（base）と比べ、それぞれが足した・消した・変えたところを取り込む。
// 同じところを両方で変えたときだけ、この端末の内容を残す。
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
  let pullPromise = null;

  // base は単位ごとの「前回そろえた内容」。2台の変更をまとめるときの基準にする。
  function loadMeta() {
    const empty = { enabled: false, lastServerRev: 0, revs: {}, hashes: {}, base: {}, lastSyncAt: null, error: '' };
    try {
      const loaded = { ...empty, ...JSON.parse(localStorage.getItem(META_KEY)) };
      loaded.base = loaded.base || {};
      return loaded;
    } catch (e) { return empty; }
  }

  const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

  /* ---------- 2台の変更をまとめる ---------- */

  const isMap = v => v !== null && typeof v === 'object' && !Array.isArray(v);

  // キーの順番に左右されない比較用の文字列
  function stable(v) {
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
    if (isMap(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
    return JSON.stringify(v === undefined ? null : v);
  }
  const same = (a, b) => stable(a) === stable(b);

  // 一覧の要素を見分ける目印。付箋などは id、完了履歴は「種類・付箋・日付」、文字列はその値。
  function itemKey(item) {
    if (item === null || typeof item !== 'object') return `v:${JSON.stringify(item)}`;
    if (item.id) return `id:${item.id}`;
    if (item.refId) return `h:${item.kind}|${item.refId}|${item.day}`;
    return null;
  }

  // 一覧を「目印 → 要素」に直す。目印のない要素があればまとめられないので null。
  function listEntries(list) {
    const entries = new Map();
    for (const item of list) {
      const key = itemKey(item);
      if (key === null) return null;
      let unique = key;
      for (let n = 2; entries.has(unique); n++) unique = `${key}#${n}`;
      entries.set(unique, item);
    }
    return entries;
  }

  // 目印ごとにまとめる。並びはこの端末の順を基本に、共有先にだけあるものは共有先で直前にあったものの後ろへ入れる。
  function mergeEntries(base, local, remote) {
    const order = [...local.keys()];
    let prev = null;
    remote.forEach((_, key) => {
      if (!local.has(key)) order.splice(prev === null ? 0 : order.indexOf(prev) + 1, 0, key);
      prev = key;
    });
    const out = new Map();
    order.forEach(key => {
      const inBase = base.has(key);
      if (local.has(key) && remote.has(key)) {
        out.set(key, merge3(inBase ? base.get(key) : undefined, local.get(key), remote.get(key)));
      } else if (local.has(key)) {
        // 共有先で消したもの（この端末で変えていなければ消す）
        if (!(inBase && same(local.get(key), base.get(key)))) out.set(key, local.get(key));
      } else if (!(inBase && same(remote.get(key), base.get(key)))) {
        // この端末で消したもの（共有先で変えていなければ消す）
        out.set(key, remote.get(key));
      }
    });
    return out;
  }

  // base から local・remote それぞれへの変更を両方取り込む。base が undefined なら、足し合わせる。
  function merge3(base, local, remote) {
    if (same(local, remote)) return local;
    if (base !== undefined && same(local, base)) return remote;
    if (base !== undefined && same(remote, base)) return local;
    if (Array.isArray(local) && Array.isArray(remote)) {
      const b = listEntries(Array.isArray(base) ? base : []);
      const l = listEntries(local);
      const r = listEntries(remote);
      if (b && l && r) return [...mergeEntries(b, l, r).values()];
      return local;
    }
    if (isMap(local) && isMap(remote)) {
      const toEntries = obj => new Map(Object.entries(isMap(obj) ? obj : {}));
      return Object.fromEntries(mergeEntries(toEntries(base), toEntries(local), toEntries(remote)));
    }
    return local;
  }

  // 2台がそれぞれ同じくり返し付箋を貼っていたら、1日1枚に戻す（完了したほうを残す）
  function dedupeRepeats(day) {
    const chosen = new Map();
    Object.values(day).forEach(list => list.forEach(task => {
      if (!task.repeatId) return;
      const kept = chosen.get(task.repeatId);
      if (!kept || (!kept.done && task.done)) chosen.set(task.repeatId, task);
    }));
    const out = {};
    Object.entries(day).forEach(([blockId, list]) => {
      const kept = list.filter(task => !task.repeatId || chosen.get(task.repeatId) === task);
      if (kept.length) out[blockId] = kept;
    });
    return out;
  }

  function mergeUnit(key, base, local, remote) {
    const merged = merge3(base, local, remote);
    return key.startsWith('work/') && isMap(merged) ? dedupeRepeats(merged) : merged;
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

  // 新しい分を受け取る。同時に呼ばれたら、取得中の分の結果を待つ。
  function pull() {
    if (!meta.enabled || !S.state.settings.calendarUrl) return Promise.resolve();
    if (!pullPromise) pullPromise = pullOnce().finally(() => { pullPromise = null; });
    return pullPromise;
  }

  async function pullOnce() {
    try {
      const data = await call('GET', { action: 'pull', since: meta.lastServerRev });
      const units = currentUnits();
      const changed = new Set();
      Object.entries(data.units).forEach(([key, unit]) => {
        // すでに知っている版（自分が送った分など）より古い・同じなら使わない。
        // 取得が送信の完了より後に届いたとき、古い内容で戻さないため。
        if (unit.rev <= (meta.revs[key] || 0)) return;
        const local = key in units ? units[key] : (key.includes('/') ? {} : undefined);
        const dirty = hash(local) !== meta.hashes[key];
        // この端末に未送信の変更があれば、上書きせずに両方の変更をまとめる（まとめた分は次の送信で送る）
        const next = dirty ? mergeUnit(key, meta.base[key], local, unit.value) : unit.value;
        meta.revs[key] = unit.rev;
        meta.hashes[key] = hash(unit.value);
        meta.base[key] = clone(unit.value);
        if (hash(next) !== hash(local)) changed.add(applyUnit(key, clone(next)));
      });
      meta.lastServerRev = data.serverRev;
      if (changed.size) {
        S.commit(...changed);
        Y.onRemoteChange();
      }
      succeeded();
    } catch (e) {
      failed(e);
    }
  }

  async function push() {
    if (!meta.enabled || !S.state.settings.calendarUrl) return;
    if (pushing) {
      schedulePush();
      return;
    }
    if (!dirtyUnits().length) return;
    pushing = true;
    try {
      // 送る前に、もう一方の端末の変更を受け取ってまとめておく
      await pull();
      // 送る内容はこの時点の写しにする。送信中に変えた分を「送った」と数えないため（変えた分は次の送信で送る）。
      const dirty = dirtyUnits().map(u => ({ key: u.key, value: clone(u.value) }));
      if (!dirty.length) return;
      const data = await call('POST', null, {
        action: 'push',
        units: dirty.map(u => ({ key: u.key, value: u.value, baseRev: meta.revs[u.key] || 0 })),
      });
      dirty.forEach(u => {
        meta.hashes[u.key] = hash(u.value);
        meta.revs[u.key] = data.revs[u.key];
        meta.base[u.key] = u.value;
      });
      // 送信中に変わった分があれば続けて送る
      if (dirtyUnits().length) schedulePush();
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
    _merge: mergeUnit, // テスト用

    // 共有を始める。共有データがまだなければこの端末の内容を基準にし、あれば確認のうえ共有データに置き換える。
    async enable(confirmReplace) {
      const data = await call('GET', { action: 'pull', since: 0 });
      const serverKeys = Object.keys(data.units);
      if (!serverKeys.length) {
        meta = { ...meta, enabled: true, lastServerRev: data.serverRev, revs: {}, hashes: {}, base: {}, error: '' };
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
      meta = { ...meta, enabled: true, lastServerRev: data.serverRev, revs: {}, hashes: {}, base: {}, error: '' };
      serverKeys.forEach(key => {
        applyUnit(key, clone(data.units[key].value));
        meta.revs[key] = data.units[key].rev;
        meta.hashes[key] = hash(data.units[key].value);
        meta.base[key] = clone(data.units[key].value);
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
      // 以前の版から引き継いだ端末は base を持っていないので、送信済みの単位は今の内容を base にする
      const units = currentUnits();
      Object.keys(meta.hashes).forEach(key => {
        if (key in meta.base) return;
        const local = key in units ? units[key] : (key.includes('/') ? {} : undefined);
        if (hash(local) === meta.hashes[key]) meta.base[key] = clone(local);
      });
      saveMeta();
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
