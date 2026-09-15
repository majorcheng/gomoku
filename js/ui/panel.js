/**
 * panel.js - 侧边栏视图（对局信息 / 搜索数据表 / 实时状态 / 引擎参数）
 *
 * 纯渲染模块：所有内容都由 app.js 推进来，自己不持任何对局状态。
 *
 * @license MIT
 */

import { BLACK, colorName, coordName } from '../rules.js';

// difficulty.js 是经典脚本（Worker 里要 importScripts），在 module 之前加载，
// 这里直接读全局对象
const Difficulty = window.Difficulty;

const $ = (id) => document.getElementById(id);

const MODE_NAMES = { pve: '人机对战', pvp: '本机双人', eve: '机机对战' };

/** 必胜/必败分阈值（与 difficulty.js 的 WIN_BASE 一致） */
const WIN_BASE = Difficulty.WIN_BASE;

function fmtInt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US');
}

function fmtNps(n) {
  if (!n) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

/** 分数显示（黑方视角）：正 = 黑优（蓝），负 = 白优（黄），必胜量级标"胜/败" */
function scoreCell(score) {
  if (score === null || score === undefined || Number.isNaN(score)) return '<td>—</td>';
  if (score >= WIN_BASE) return '<td class="score-positive">必胜</td>';
  if (score <= -WIN_BASE) return '<td class="score-negative">必败</td>';
  const cls = score > 0 ? 'score-positive' : score < 0 ? 'score-negative' : 'score-neutral';
  const sign = score > 0 ? '+' : '';
  return `<td class="${cls}">${sign}${fmtInt(score)}</td>`;
}

/** 评估条：黑上白下，分数经 tanh 压缩（悔棋后传 null 复位为中线） */
export function setEvalBar(blackScore) {
  const bar = $('eval-bar-white');
  if (!bar) return;
  if (blackScore === null || blackScore === undefined || Number.isNaN(blackScore)) {
    bar.style.height = '50%';
  } else if (blackScore >= WIN_BASE) {
    bar.style.height = '0%';
  } else if (blackScore <= -WIN_BASE) {
    bar.style.height = '100%';
  } else {
    const t = Math.tanh(blackScore / 20000);
    bar.style.height = ((1 - t) * 50).toFixed(1) + '%';
  }
  const top = $('eval-label-top'), bottom = $('eval-label-bottom');
  if (top && bottom) {
    if (blackScore >= WIN_BASE) { top.textContent = '胜'; bottom.textContent = ''; }
    else if (blackScore <= -WIN_BASE) { top.textContent = ''; bottom.textContent = '胜'; }
    else {
      top.textContent = blackScore > 0 ? '+' + compactScore(blackScore) : '';
      bottom.textContent = blackScore < 0 ? compactScore(-blackScore) : '';
    }
  }
}

function compactScore(s) {
  if (Math.abs(s) >= 1000) return (s / 1000).toFixed(1) + 'k';
  return String(Math.round(s));
}

/** 重置全部面板（新对局时调用） */
export function reset() {
  $('ai-stats-body').innerHTML = '';
  $('stats-empty').classList.remove('hide');
  $('ai-current').textContent = '引擎就绪。';
  $('ai-current').classList.remove('busy');
  setEvalBar(null);
  $('info-opening') && ($('info-opening').textContent = '—');
}

/** 对局信息区 */
export function setInfo({ mode, level, turn, thinking, lastMove, moveCount }) {
  $('info-mode').textContent = MODE_NAMES[mode] || '—';
  const def = level ? Difficulty.getLevel(level) : null;
  $('info-level').textContent = def ? `Lv.${def.level} ${def.label}` : '—';
  $('info-turn').textContent = thinking ? '引擎思考中…' : (turn ? colorName(turn) : '—');
  $('info-last').textContent = lastMove !== undefined && lastMove !== null && lastMove >= 0
    ? coordName(lastMove) : '—';
  $('info-count').textContent = moveCount !== undefined ? `${moveCount} 手` : '—';
}

/**
 * 追加一行走子记录。
 * entry: { color, source: 'human'|'ai'|'ai-sub'|'ai-vcf', move,
 *          depth, nodes, nps, timeMs, score(黑方视角) }
 */
export function addMoveRow(entry) {
  const body = $('ai-stats-body');
  const empty = $('stats-empty');
  if (empty) empty.classList.add('hide');

  const no = body.children.length + 1;
  const srcText = {
    human: '玩家',
    ai: 'AI',
    'ai-sub': 'AI·次优',
    'ai-vcf': 'AI·VCF'
  }[entry.source] || '—';
  const srcCls = entry.source === 'human' ? 'source-human' : 'source-ai';

  const tr = document.createElement('tr');
  if (entry.source === 'ai-sub') tr.className = 'suboptimal';
  tr.innerHTML =
    `<td>${no}</td>` +
    `<td>${entry.color === BLACK ? '黑' : '白'}</td>` +
    `<td class="${srcCls}${entry.source === 'ai-vcf' ? ' src-vcf' : ''}">${srcText}</td>` +
    `<td class="mv">${coordName(entry.move)}</td>` +
    `<td>${entry.depth !== undefined ? entry.depth : '—'}</td>` +
    `<td>${fmtInt(entry.nodes)}</td>` +
    `<td>${fmtNps(entry.nps)}</td>` +
    `<td>${entry.timeMs !== undefined ? entry.timeMs + 'ms' : '—'}</td>` +
    scoreCell(entry.score);
  body.appendChild(tr);

  // 追加后滚到最底，最新一手始终可见
  const scroll = body.closest('.table-scroll');
  if (scroll) scroll.scrollTop = scroll.scrollHeight;

  if (entry.score !== undefined && entry.score !== null && !Number.isNaN(entry.score)) {
    setEvalBar(entry.score);
  }
}

/** 底部实时状态栏（迭代加深进度 / 就绪） */
export function setCurrent(text, busy) {
  const el = $('ai-current');
  el.textContent = text;
  el.classList.toggle('busy', !!busy);
}

/** info 流 → 实时状态栏一行字 */
export function showInfo(info) {
  setCurrent(
    `深度 ${info.depth} · ${fmtInt(info.nodes)} 节点 · ${fmtNps(info.nps)} NPS · ${info.timeMs}ms`,
    true
  );
}

/** 引擎参数卡：如实展示当前档位生效的搜索参数 */
export function setEngineFacts(level) {
  const def = Difficulty.getLevel(level);
  $('engine-facts').innerHTML =
    `算法：迭代加深 Negamax α-β + Zobrist 置换表<br>` +
    `档位：<span class="ok">Lv.${def.level} ${def.label}</span><br>` +
    `深度上限：${def.depth > 0 ? def.depth + ' 层' : '不限（按时间）'} · ` +
    `时间上限：${def.timeMs}ms<br>` +
    `候选宽度：${def.candWidth}（深层 ${Math.max(8, def.candWidth >> 1)}） · ` +
    `VCF 算杀：${def.vcf ? '<span class="ok">开</span>' : '关'}<br>` +
    `采样温度：${def.temperature > 0 ? def.temperature : '无（永远首选）'} · ` +
    `失误率：${def.blunder > 0 ? Math.round(def.blunder * 100) + '%' : '无'}`;
}
