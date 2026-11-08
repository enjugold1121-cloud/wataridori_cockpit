// データと保存。保存先は adapter の差し替えだけで Google Sheets やクラウドDBへ移せる。
window.WB = window.WB || {};
(function (WB) {
  'use strict';

  const PREFIX = 'wb.v1.';
  const COLLECTIONS = ['holds', 'work', 'workRepeats', 'repeatLog', 'lifeTemplate', 'lifeLog', 'history', 'settings', 'timer'];

  // load(name) / save(name, value) の2つを実装すれば別の保存先になる。どちらも非同期でよい。
  const localStorageAdapter = {
    async load(name) {
      let raw = null;
      try {
        raw = localStorage.getItem(PREFIX + name);
        return raw === null ? null : JSON.parse(raw);
      } catch (e) {
        // 壊れたデータは上書きで失わないよう、別キーへ退避してから初期値で起動する
        if (raw !== null) {
          try { localStorage.setItem(`${PREFIX}corrupt.${name}.${Date.now()}`, raw); } catch (ignored) {}
        }
        return null;
      }
    },
    async save(name, value) {
      localStorage.setItem(PREFIX + name, JSON.stringify(value));
    },
  };

  const defaults = () => ({
    holds: [],            // [{id, text, pinned, reviewDate, createdAt}]
    work: {},             // {'YYYY-MM-DD': {blockId: [{id, text, done, doneAt, createdAt, repeatId?}]}}
    workRepeats: [],      // [{id, text, title, createdAt}] 予定の名前に紐づくくり返し付箋の雛形
    repeatLog: {},        // {'YYYY-MM-DD': [repeatId]} その日に貼り済み（外した場合も含む）
    lifeTemplate: { am: [], pm: [], eve: [] }, // {band: [{id, text}]} 毎日くり返す雛形
    lifeLog: {},          // {'YYYY-MM-DD': {templateId: doneAtISO}} 完了記録は日付別
    history: [],          // [{refId, kind, text, day, context, doneAt}] 振り返り用
    settings: { amStart: '05:00', pmStart: '12:00', eveStart: '17:00', theme: 'light', chime: true },
    timer: { phase: 'idle', endsAt: null, pausedLeft: null },
  });

  const SEED_HOLDS = ['来月以降に見直す改善案', '時間ができたら試すアイデア', '今は判断しない調査メモ'];
  const SEED_LIFE = {
    am: ['朝食', '食後の片付け', '洗濯・身支度'],
    pm: ['昼食・片付け', '20分の仮眠'],
    eve: ['洗濯物の取り込み', '夕食・片付け', '入浴・就寝準備'],
  };

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const nowISO = () => new Date().toISOString();

  const state = {};
  const adapter = localStorageAdapter;
  const COLLECTION_OF = { hold: 'holds', work: 'work', life: 'lifeTemplate' };

  const S = {
    state,
    onSaveError: null,
    onExternalChange: null,

    // 初回起動なら true を返す
    async init() {
      const base = defaults();
      for (const name of COLLECTIONS) {
        const loaded = await adapter.load(name);
        state[name] = loaded === null ? base[name] : loaded;
      }
      state.settings = { ...base.settings, ...state.settings };
      const firstRun = (await adapter.load('meta')) === null;
      if (firstRun) {
        state.holds = SEED_HOLDS.map(text => makeHold(text));
        for (const band of Object.keys(SEED_LIFE)) {
          state.lifeTemplate[band] = SEED_LIFE[band].map(text => ({ id: uid(), text }));
        }
        S.commit(...COLLECTIONS);
        save('meta', { createdAt: nowISO() });
      }
      // 別タブでの変更を取り込み、古い状態で上書きしないようにする
      window.addEventListener('storage', async e => {
        if (!e.key || !e.key.startsWith(PREFIX)) return;
        for (const name of COLLECTIONS) {
          const loaded = await adapter.load(name);
          if (loaded !== null) state[name] = loaded;
        }
        if (S.onExternalChange) S.onExternalChange();
      });
      return firstRun;
    },

    commit(...names) {
      names.forEach(name => save(name, state[name]));
    },

    snapshot() {
      const copy = {};
      COLLECTIONS.forEach(name => { copy[name] = state[name]; });
      return JSON.stringify(copy);
    },

    restore(snapshot) {
      Object.assign(state, JSON.parse(snapshot));
      S.commit(...COLLECTIONS);
    },

    tasks(day, blockId) {
      return (state.work[day] && state.work[day][blockId]) || [];
    },

    // 重要な保留（固定または再検討日到来）を先頭に並べた表示順
    isImportantHold(hold, today) {
      return hold.pinned || Boolean(hold.reviewDate && hold.reviewDate <= today);
    },
    orderedHolds(today) {
      const important = state.holds.filter(h => S.isImportantHold(h, today));
      const rest = state.holds.filter(h => !S.isImportantHold(h, today));
      return [...important, ...rest];
    },

    find(ref) {
      return listOf(ref).find(item => item.id === ref.id) || null;
    },

    add(listRef, text) {
      if (listRef.kind === 'hold') state.holds.unshift(makeHold(text));
      else if (listRef.kind === 'life') state.lifeTemplate[listRef.band].push({ id: uid(), text });
      else listOf(listRef, true).push(makeTask(text));
      S.commit(COLLECTION_OF[listRef.kind]);
    },

    update(ref, patch, today) {
      const item = S.find(ref);
      if (!item) return;
      Object.assign(item, patch);
      if (patch.text && ref.kind === 'work') {
        state.history
          .filter(h => h.kind === 'work' && h.refId === item.id)
          .forEach(h => { h.text = patch.text; });
        S.commit('history');
        if (item.repeatId) syncRepeatText(item.repeatId, patch.text, today);
      }
      S.commit(COLLECTION_OF[ref.kind]);
    },

    /* ---------- くり返し付箋 ---------- */

    repeatOf(id) {
      return state.workRepeats.find(r => r.id === id) || null;
    },

    // 付箋を雛形にし、同じ名前の予定がある日に毎回出す。元の付箋はその日の1枚として扱う。
    makeRepeat(ref, title) {
      const task = S.find(ref);
      if (!task || task.repeatId) return;
      const repeat = { id: uid(), text: task.text, title, createdAt: nowISO() };
      state.workRepeats.push(repeat);
      task.repeatId = repeat.id;
      markPlaced(ref.day, repeat.id);
      S.commit('workRepeats', 'work', 'repeatLog');
    },

    // くり返しをやめる。今日以降の未完了のコピーは片付け、この付箋と完了済みは普通の付箋として残す。
    stopRepeat(ref, today) {
      const task = S.find(ref);
      if (!task || !task.repeatId) return;
      const repeatId = task.repeatId;
      state.workRepeats = state.workRepeats.filter(r => r.id !== repeatId);
      Object.keys(state.work).forEach(day => {
        Object.keys(state.work[day]).forEach(blockId => {
          const list = state.work[day][blockId].filter(t =>
            t.repeatId !== repeatId || t.id === task.id || t.done || day < today);
          list.forEach(t => { if (t.repeatId === repeatId) delete t.repeatId; });
          state.work[day][blockId] = list;
        });
        Object.keys(state.work[day]).forEach(blockId => pruneDay({ kind: 'work', day, blockId }));
      });
      S.commit('workRepeats', 'work');
    },

    // その日の予定に合う雛形を、最初の同名ブロックへ1日1枚だけ貼る。外した日は貼り直さない。
    placeRepeats(day, events) {
      const placed = state.repeatLog[day] || [];
      const sorted = events.slice().sort((a, b) => a.start.localeCompare(b.start));
      let changed = false;
      state.workRepeats.forEach(repeat => {
        if (placed.includes(repeat.id)) return;
        const block = sorted.find(ev => ev.title === repeat.title);
        if (!block) return;
        listOf({ kind: 'work', day, blockId: block.id }, true).push({ ...makeTask(repeat.text), repeatId: repeat.id });
        placed.push(repeat.id);
        changed = true;
      });
      if (changed) {
        state.repeatLog[day] = placed;
        S.commit('work', 'repeatLog');
      }
    },

    remove(ref) {
      const list = listOf(ref);
      const index = list.findIndex(item => item.id === ref.id);
      if (index >= 0) list.splice(index, 1);
      pruneDay(ref);
      S.commit(COLLECTION_OF[ref.kind]);
    },

    // 同じ一覧の中で1つ前後へ動かす。保留は重要グループをまたがない。
    shift(ref, delta, today) {
      if (ref.kind === 'hold') {
        const ordered = S.orderedHolds(today);
        const i = ordered.findIndex(h => h.id === ref.id);
        const j = i + delta;
        if (j < 0 || j >= ordered.length) return;
        if (S.isImportantHold(ordered[i], today) !== S.isImportantHold(ordered[j], today)) return;
        [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
        state.holds = ordered;
      } else {
        const list = listOf(ref);
        const i = list.findIndex(item => item.id === ref.id);
        const j = i + delta;
        if (j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
      }
      S.commit(COLLECTION_OF[ref.kind]);
    },

    // 一覧をまたぐ移動・並べ替えの共通処理。order を渡すとその並びに揃える。
    transfer(srcRef, dstRef, id, order) {
      const src = listOf(srcRef);
      const index = src.findIndex(item => item.id === id);
      if (index < 0) return false;
      if (srcRef.kind === 'work' && dstRef.kind === 'hold' && src[index].done) return false;
      const [item] = src.splice(index, 1);
      const moved = convert(item, srcRef.kind, dstRef.kind);
      const dst = listOf(dstRef, true);
      if (dstRef.kind === 'hold' && !order) dst.unshift(moved);
      else dst.push(moved);
      if (order) dst.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      pruneDay(srcRef);
      S.commit(COLLECTION_OF[srcRef.kind], COLLECTION_OF[dstRef.kind]);
      return true;
    },

    toggleWork(ref, context) {
      const task = S.find(ref);
      if (!task) return;
      task.done = !task.done;
      task.doneAt = task.done ? nowISO() : null;
      if (task.done) {
        state.history.push({ refId: task.id, kind: 'work', text: task.text, day: ref.day, context, doneAt: task.doneAt });
      } else {
        state.history = state.history.filter(h => !(h.kind === 'work' && h.refId === task.id && h.day === ref.day));
      }
      S.commit('work', 'history');
    },

    lifeDone(day, id) {
      return Boolean(state.lifeLog[day] && state.lifeLog[day][id]);
    },

    toggleLife(day, item, context) {
      const log = state.lifeLog[day] || (state.lifeLog[day] = {});
      if (log[item.id]) {
        delete log[item.id];
        state.history = state.history.filter(h => !(h.kind === 'life' && h.refId === item.id && h.day === day));
      } else {
        log[item.id] = nowISO();
        state.history.push({ refId: item.id, kind: 'life', text: item.text, day, context, doneAt: log[item.id] });
      }
      S.commit('lifeLog', 'history');
    },

    historyOf(day) {
      return state.history
        .filter(h => h.day === day)
        .sort((a, b) => a.doneAt.localeCompare(b.doneAt));
    },
  };

  function save(name, value) {
    Promise.resolve()
      .then(() => adapter.save(name, value))
      .catch(err => { if (S.onSaveError) S.onSaveError(err); });
  }

  function listOf(ref, create) {
    if (ref.kind === 'hold') return state.holds;
    if (ref.kind === 'life') return state.lifeTemplate[ref.band];
    if (!state.work[ref.day]) {
      if (!create) return [];
      state.work[ref.day] = {};
    }
    if (!state.work[ref.day][ref.blockId]) {
      if (!create) return [];
      state.work[ref.day][ref.blockId] = [];
    }
    return state.work[ref.day][ref.blockId];
  }

  function pruneDay(ref) {
    if (ref.kind !== 'work' || !state.work[ref.day]) return;
    if (state.work[ref.day][ref.blockId] && !state.work[ref.day][ref.blockId].length) {
      delete state.work[ref.day][ref.blockId];
    }
    if (!Object.keys(state.work[ref.day]).length) delete state.work[ref.day];
  }

  function markPlaced(day, repeatId) {
    const placed = state.repeatLog[day] || (state.repeatLog[day] = []);
    if (!placed.includes(repeatId)) placed.push(repeatId);
  }

  // 文字の変更は雛形と、今日以降の未完了のコピーにも反映する
  function syncRepeatText(repeatId, text, today) {
    const repeat = S.repeatOf(repeatId);
    if (repeat) repeat.text = text;
    Object.keys(state.work).filter(day => day >= today).forEach(day => {
      Object.values(state.work[day]).forEach(list => list.forEach(t => {
        if (t.repeatId === repeatId && !t.done) t.text = text;
      }));
    });
    S.commit('workRepeats', 'work');
  }

  function makeHold(text) {
    return { id: uid(), text, pinned: false, reviewDate: null, createdAt: nowISO() };
  }

  function makeTask(text) {
    return { id: uid(), text, done: false, doneAt: null, createdAt: nowISO() };
  }

  function convert(item, fromKind, toKind) {
    if (fromKind === toKind) return item;
    if (toKind === 'hold') return { id: item.id, text: item.text, pinned: false, reviewDate: null, createdAt: item.createdAt };
    return { id: item.id, text: item.text, done: false, doneAt: null, createdAt: item.createdAt };
  }

  WB.store = S;
})(window.WB);
