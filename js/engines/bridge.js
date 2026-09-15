/**
 * bridge.js - 引擎门面（主线程）
 *
 * 把 engine.worker.js 的消息协议收敛成一个异步门面：
 *
 *   Bridge.load()                       创建 Worker 并等待 ready 握手
 *   Bridge.search(moves, level, onInfo) → Promise<result>   发起搜索
 *   Bridge.cancel()                     作废在途搜索（悔棋/重开/连点时用）
 *   Bridge.unload()                     终结 Worker
 *
 * ── seq 配对与过期应答 ───────────────────────────────────────────────
 *
 * 用户在引擎思考时悔棋/重开是常态，Worker 里旧局面的搜索结果回来时已经
 * 没有意义。每次 search 自增 seq，Worker 的 info/result 原样带回；
 * bridge 只把**当前 seq** 的消息交给调用方，旧的静默丢弃。
 * cancel() 只是把 currentSeq 置为 -1，让在途结果全部变成过期应答，
 * Promise 以 null 兑现（不 reject，调用方判空即可）。
 *
 * ── 为什么不让 Worker 里 stop ────────────────────────────────────────
 *
 * 引擎按档位 timeMs 在搜索检查点结束，检查间隔可能带来少量超时。
 * 悔棋后旧搜索最多再跑几秒就自己结束，不值得为 stop 协议增加
 * 「检查点安全退出」的复杂度——那是 C++ 引擎的做法，JS 里重建 Worker
 * （unload + load）反而更贵。丢弃过期结果是最简单且正确的策略。
 *
 * @license MIT
 */

(function (global) {
  'use strict';

  var worker = null;
  var ready = false;
  var loading = null;        // load() 的 Promise（防并发重复创建）
  var currentSeq = 0;
  var pending = null;        // { seq, resolve, onInfo }

  /** 创建 Worker 并等待 ready 握手（幂等，可重复调用） */
  function load() {
    if (ready) return Promise.resolve();
    if (loading) return loading;

    loading = new Promise(function (resolve, reject) {
      try {
        worker = new Worker('js/engines/engine.worker.js', { type: 'module' });
      } catch (err) {
        loading = null;
        reject(err);
        return;
      }
      worker.addEventListener('message', function (ev) {
        var msg = ev.data;
        if (!msg) return;
        if (msg.type === 'ready') {
          ready = true;
          loading = null;
          resolve();
          return;
        }
        // 只放行当前 seq 的应答；过期的（cancel/新搜索之后的）静默丢弃
        if (!pending || msg.seq !== pending.seq) return;
        if (msg.type === 'info') {
          if (pending.onInfo) pending.onInfo(msg);
        } else if (msg.type === 'result') {
          var done = pending;
          pending = null;
          done.resolve(msg);
        } else if (msg.type === 'error') {
          var failed = pending;
          pending = null;
          failed.resolve(null);   // 引擎异常按"无结果"处理，UI 显示引擎故障
          if (typeof console !== 'undefined') console.error('[gomoku] engine error:', msg.message);
        }
      });
      worker.addEventListener('error', function (ev) {
        ready = false;
        loading = null;
        reject(new Error(ev.message || 'engine worker failed to load'));
        if (pending) { pending.resolve(null); pending = null; }
        ev.preventDefault && ev.preventDefault();
      });
    });
    return loading;
  }

  /**
   * 发起搜索。
   *
   * @param {number[]} moves 完整着法序列（一维下标）
   * @param {number} level 难度档位号
   * @param {function(Object):void} [onInfo] 迭代加深进度回调（真实深度/节点/耗时）
   * @returns {Promise<Object|null>} result 消息；被 cancel 或引擎故障时为 null
   */
  function search(moves, level, onInfo) {
    if (!ready || !worker) {
      return Promise.reject(new Error('engine not loaded'));
    }
    cancelPending();   // 严谨起见：同一时刻只允许一个在途搜索
    var seq = ++currentSeq;
    return new Promise(function (resolve) {
      pending = { seq: seq, resolve: resolve, onInfo: onInfo };
      worker.postMessage({ type: 'search', seq: seq, moves: moves, level: level });
    });
  }

  /** 作废在途搜索（结果以 null 兑现），不终止 Worker */
  function cancel() {
    cancelPending();
  }

  function cancelPending() {
    if (pending) {
      var done = pending;
      pending = null;
      done.resolve(null);
    }
  }

  /** 终结 Worker（换引擎/页面卸载时才用） */
  function unload() {
    cancelPending();
    if (worker) {
      worker.terminate();
      worker = null;
    }
    ready = false;
    loading = null;
  }

  function status() {
    return {
      loaded: ready,
      busy: pending !== null
    };
  }

  global.Bridge = {
    load: load,
    search: search,
    cancel: cancel,
    unload: unload,
    status: status
  };

})(typeof self !== 'undefined' ? self : this);
