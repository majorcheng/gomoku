/**
 * app.js - 主控（装配棋盘、裁判、引擎；对局流程）
 *
 * 全应用唯一的调度中心：谁该走、走完判什么、什么时候轮到引擎、悔棋退几步、
 * 终局怎么收尾，都在这里。棋盘/面板/菜单三个视图模块只负责渲染，
 * 规则全交给 rules.js，难度档位与采样全交给 difficulty.js。
 *
 * 依赖的全局对象（由 index.html 里的经典脚本提供）：
 *   window.Difficulty  js/difficulty.js
 *   window.Bridge      js/engines/bridge.js
 *
 * ── generation 机制 ──────────────────────────────────────────────────
 * 每次重开/悔棋/回菜单都 +1。引擎结果回来时先对 seq/generation，
 * 过期的直接丢弃——用户连点、悔棋时在途的旧搜索不会污染新局面。
 *
 * @license MIT
 */

import * as rules from './rules.js';
import { createBoard } from './ui/board.js';
import * as panel from './ui/panel.js';
import * as menu from './ui/menu.js';

const COUNTER_KEY = 'gomoku-counters';
const Difficulty = window.Difficulty;
const Bridge = window.Bridge;

const BLACK = rules.BLACK, WHITE = rules.WHITE;

let game = rules.createGame();
let board = null;

const state = {
  mode: 'pve',            // 'pve' | 'pvp' | 'eve'
  humanColor: BLACK,      // pve 下玩家执子
  level: Difficulty.DEFAULT_LEVEL,
  generation: 0,          // 作废在途引擎结果
  thinking: false,
  started: false,         // 是否已开局（菜单遮罩期间 false）
  eveTimer: null
};

// ── 工具 ─────────────────────────────────────────────────────────────

function isHumanTurn() {
  if (game.over || !state.started) return false;
  if (state.mode === 'pvp') return true;
  if (state.mode === 'eve') return false;
  return rules.turnOf(game) === state.humanColor;
}

function loadCounters() {
  try {
    const raw = localStorage.getItem(COUNTER_KEY);
    if (!raw) return { b: 0, w: 0 };
    const obj = JSON.parse(raw);
    return { b: Number(obj.b) || 0, w: Number(obj.w) || 0 };
  } catch (err) {
    return { b: 0, w: 0 };
  }
}

function saveCounters(c) {
  try { localStorage.setItem(COUNTER_KEY, JSON.stringify(c)); } catch (err) { /* 忽略 */ }
}

function bumpCounter(color) {
  const counters = loadCounters();
  if (color === BLACK) counters.b += 1;
  else if (color === WHITE) counters.w += 1;
  saveCounters(counters);
  const el = document.getElementById(color === BLACK ? 'black-counter' : 'white-counter');
  if (el) {
    el.textContent = color === BLACK ? counters.b : counters.w;
    el.classList.add('bump');
    setTimeout(() => el.classList.remove('bump'), 260);
  }
}

function renderCounters() {
  const counters = loadCounters();
  document.getElementById('black-counter').textContent = counters.b;
  document.getElementById('white-counter').textContent = counters.w;
}

/** 引擎分（行棋方视角）→ 黑方视角（评估条与表格统一口径） */
function toBlackScore(score, mover) {
  if (score === null || score === undefined || Number.isNaN(score)) return null;
  return mover === BLACK ? score : -score;
}

// ── 刷新视图 ─────────────────────────────────────────────────────────

function refresh(animateLast) {
  board.setPosition(game, animateLast);
  board.setInteractive(isHumanTurn());
  document.getElementById('board-stage').classList.toggle('thinking', state.thinking);
  panel.setInfo({
    mode: state.mode,
    level: state.mode === 'pvp' ? 0 : state.level,
    turn: game.over ? null : rules.turnOf(game),
    thinking: state.thinking,
    lastMove: game.moves.length ? game.moves[game.moves.length - 1] : -1,
    moveCount: game.moves.length
  });
}

// ── 终局 ─────────────────────────────────────────────────────────────

function finishGame(result) {
  state.thinking = false;
  refresh(false);

  if (result.win) {
    bumpCounter(game.winner);
    const from = rules.coordName(game.winLine[0]);
    const to = rules.coordName(game.winLine[game.winLine.length - 1]);
    menu.showSummary({
      title: game.winner === BLACK ? '黑方五连获胜' : '白方五连获胜',
      text: `获胜连线 <strong>${from} → ${to}</strong>，共 ${game.moves.length} 手。`
    });
  } else {
    menu.showSummary({
      title: '和棋',
      text: `${rules.AREA} 个交叉点全部落满，未分出胜负。`
    });
  }
  panel.setCurrent(
    game.over ? (game.winner ? `${rules.colorName(game.winner)}获胜（${game.moves.length} 手）` : '满盘和棋') : '引擎就绪。'
  );
}

/** 落子总入口：place 之后刷新、记录、判终局、轮转 */
function applyMove(idx, stats) {
  const mover = rules.turnOf(game);
  const result = rules.place(game, idx);
  if (!result.legal) return;

  panel.addMoveRow(Object.assign(
    {
      color: mover,
      source: 'human',
      move: idx,
      depth: undefined, nodes: undefined, nps: undefined, timeMs: undefined,
      score: undefined
    },
    stats || {}
  ));

  refresh(true);

  if (result.win || result.full) {
    finishGame(result);
    return true;
  }
  return false;
}

// ── AI 行棋 ──────────────────────────────────────────────────────────

function aiMove() {
  if (game.over || !state.started) return;
  const mover = rules.turnOf(game);
  const gen = state.generation;

  state.thinking = true;
  refresh(false);
  panel.setCurrent('引擎思考中…', true);

  Bridge.search(game.moves.slice(), state.level, (info) => {
    if (gen === state.generation) panel.showInfo(info);
  }).then((result) => {
    // 过期结果（重开/悔棋/回菜单之后回来的）直接丢弃
    if (gen !== state.generation || !result) {
      if (gen === state.generation && !result) {
        state.thinking = false;
        refresh(false);
        panel.setCurrent('引擎无应答。');
      }
      return;
    }
    state.thinking = false;

    // 与 Worker 共用裁判，非法搜索结果作为引擎错误报告。
    const candidates = result.candidates || [];
    const valid = candidates.every((candidate) =>
      Number.isInteger(candidate.move) &&
      Number.isFinite(candidate.score) &&
      game.board[candidate.move] === rules.EMPTY &&
      !rules.forbiddenReason(game.board, candidate.move, mover)
    );
    if (!valid || !candidates.length) {
      panel.setCurrent(valid ? '引擎未找到合法着法。' : '引擎错误：返回了非法落子或评分。');
      refresh(false);
      return;
    }

    // 选点：硬规则触发（win1/block1）或 VCF 算杀时只有一个候选、
    // 不采样；其余档位交给 Difficulty.pickMove 做温度/失误采样
    let pick;
    let source = 'ai';
    if (result.forced !== 'none' || result.vcf || candidates.length <= 1) {
      const forced = candidates.find((candidate) => candidate.move === result.move) || candidates[0];
      pick = forced ? { move: forced.move, score: forced.score, suboptimal: false } : null;
      if (result.vcf) source = 'ai-vcf';
    } else {
      pick = Difficulty.pickMove(candidates, state.level);
      if (pick && pick.suboptimal) source = 'ai-sub';
    }
    if (!pick || pick.move === null || pick.move === undefined) {
      panel.setCurrent('引擎无应答。');
      refresh(false);
      return;
    }

    const ended = applyMove(pick.move, {
      source,
      depth: result.depth,
      nodes: result.nodes,
      nps: result.nps,
      timeMs: result.timeMs,
      score: toBlackScore(pick.score, mover)
    });

    if (ended) return;

    // 机机对战：稍等片刻走下一手（便于观看）
    if (state.mode === 'eve') {
      state.eveTimer = setTimeout(() => {
        state.eveTimer = null;
        aiMove();
      }, 650);
      return;
    }

    panel.setCurrent(
      `深度 ${result.depth} · 节点 ${result.nodes.toLocaleString('en-US')} · ` +
      `${result.timeMs}ms · ${result.vcf ? 'VCF 算杀' : result.forced !== 'none' ? '强制应手' : '搜索完成'}`
    );
    refresh(false);
  });
}

// ── 人落子 ───────────────────────────────────────────────────────────

function onHumanPlace(idx) {
  if (!isHumanTurn()) return;
  if (game.board[idx] !== rules.EMPTY) return;
  const forbidden = rules.forbiddenReason(game.board, idx, rules.turnOf(game));
  if (forbidden) {
    menu.showToast(`禁手：${rules.forbiddenName(forbidden)}`);
    return;
  }
  const ended = applyMove(idx, null);
  if (!ended && !isHumanTurn()) aiMove();
}

// ── 对局控制 ─────────────────────────────────────────────────────────

function startGame(opts) {
  state.generation += 1;
  if (state.eveTimer) { clearTimeout(state.eveTimer); state.eveTimer = null; }
  Bridge.cancel();

  state.mode = opts.mode;
  state.humanColor = opts.humanColor || BLACK;
  state.level = opts.level || Difficulty.DEFAULT_LEVEL;
  state.thinking = false;
  state.started = true;

  game = rules.createGame();
  panel.reset();
  panel.setEngineFacts(state.mode === 'pvp' ? Difficulty.DEFAULT_LEVEL : state.level);
  refresh(false);
  panel.setCurrent('引擎就绪。');

  // 人机且 AI 执黑先行 / 机机对战：直接开搜
  if (state.mode === 'eve' || (state.mode === 'pve' && state.humanColor === WHITE)) {
    aiMove();
  }
}

function undoMoves() {
  if (!state.started || game.moves.length === 0) return;
  // 机机对战不给悔棋（观赏用）
  if (state.mode === 'eve') { menu.showToast('机机对战不支持悔棋'); return; }

  state.generation += 1;                 // 作废在途引擎结果
  if (state.eveTimer) { clearTimeout(state.eveTimer); state.eveTimer = null; }
  Bridge.cancel();
  state.thinking = false;

  const n = state.mode === 'pve' ? 2 : 1;
  const removed = rules.undo(game, n);
  if (removed === 0) return;

  // 统计表同步去掉对应行（人机撤 AI+人 各一行）
  const body = document.getElementById('ai-stats-body');
  for (let i = 0; i < removed && body.children.length; i++) {
    body.removeChild(body.lastChild);
  }
  if (!body.children.length) {
    document.getElementById('stats-empty').classList.remove('hide');
  }
  panel.setEvalBar(null);
  panel.setCurrent(`已悔 ${removed} 手。`);
  refresh(false);

  // 悔完如果轮到 AI（例如玩家悔掉自己唯一的着法后 AI 先行的场景），继续让 AI 走
  if (!game.over && state.started && !isHumanTurn() && state.mode === 'pve') aiMove();
}

function backToMenu() {
  state.generation += 1;
  if (state.eveTimer) { clearTimeout(state.eveTimer); state.eveTimer = null; }
  Bridge.cancel();
  state.thinking = false;
  state.started = false;
  menu.hideSummary();
  menu.showOverlay();
  refresh(false);
}

const $ = (id) => document.getElementById(id);

// ── 装配 ─────────────────────────────────────────────────────────────

function init() {
  board = createBoard($('board'), {
    onPlace: onHumanPlace,
    canPlace: (idx) => game.board[idx] === rules.EMPTY && isHumanTurn()
  });

  menu.initMenu({
    onStart: startGame,
    onSummaryRestart: () => startGame({
      mode: state.mode,
      humanColor: state.humanColor,
      level: state.level
    })
  });

  $('undobtn').addEventListener('click', undoMoves);
  $('restartbtn2').addEventListener('click', () => {
    if (state.started) startGame({ mode: state.mode, humanColor: state.humanColor, level: state.level });
  });
  $('menubtn').addEventListener('click', backToMenu);

  renderCounters();
  panel.setEngineFacts(Difficulty.DEFAULT_LEVEL);
  panel.reset();
  panel.setInfo({ mode: 'pve', level: 0, turn: null, lastMove: -1, moveCount: 0 });

  Bridge.load().catch((err) => {
    panel.setCurrent('引擎加载失败：' + err.message);
  });
}

init();
