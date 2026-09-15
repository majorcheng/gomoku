/**
 * engine.worker.js - 自研五子棋引擎（Web Worker）
 *
 * ── 算法组成 ──────────────────────────────────────────────────────────
 *
 *   根节点硬规则（任何档位都生效，见 difficulty.js 的"不可弱化的硬底线"）
 *     ① 己方任一空点能直接成五 → 立即落子（零搜索）
 *     ② 对方任一空点能直接成五 → 只在挡点里挑（快速浅搜比较挡点）
 *   ↓ 都不触发时
 *   先完成基础两层；VCF 使用有限子预算，结束后继续迭代加深。
 *   迭代加深 Negamax α-β：
 *     - Zobrist 置换表（双 32 位键校验，深度优先替换）
 *     - 杀手启发（每层 2 个）+ 历史启发（β 截断次数 × 深度²）
 *     - 候选点 = 已有棋子切比雪夫距离 ≤2 的空点，按"进攻分 + 防守分×0.9"排序
 *     - 普通候选浅层 candWidth、深层收窄一半；高级及以上保留全部真实冲四
 *     - 合法赢/挡优先；高级及以上在基础两层后额外延伸最多 4 手强制变化
 *     - 深度上限与时间上限先到者停（与 UCI go depth + movetime 同语义）
 *
 * ── 评估函数：窗口棋型表 ─────────────────────────────────────────────
 *
 * 不做"数连子 + 数堵头"的繁琐分类，而是统一用 5 格滑动窗口统计：
 * 假设在 p 落子后，沿某方向取所有包含 p 的 5 格窗口，数己方子数/空格数：
 *   5 子          → FIVE
 *   4 子 1 空     → 成五点（完成点互不相同计 2 个 → OPEN_FOUR，否则 FOUR）
 *   3 子 2 空 ×≥2 → OPEN_THREE；×1 → THREE
 *   2 子 3 空 ×≥2 → OPEN_TWO；×1 → TWO
 *   1 子 4 空     → ONE
 * 这个模型天然覆盖跳棋型（X_XXX、X_XX_X），并且"完成点不同才算活四"的
 * 判定恰好区分了 .OOOO.（活四）与 OOO_O（冲四）：前者两个窗口的空格
 * 在两侧，后者两个窗口共享同一个空格。
 *
 * 叶子评估用增量维护：每落/撤一子只重算经过该点的 4 条线（每线 ≤15 格），
 * 旧线分缓存，全局黑分 sumB / 白分 sumW 常驻内存，静态评估 O(1)。
 * 点评估缓存只在落/撤点四方向各四格内失效，排序只保留本层所需的前 K 个候选。
 *
 * ── 分数刻度（difficulty.js 的温度/损失上限按这个刻度调的）──────────
 *
 *   FIVE=10,000,000  OPEN_FOUR=1,000,000  FOUR=100,000
 *   OPEN_THREE=90,000  THREE=3,000  OPEN_TWO=2,500  TWO=300  ONE=30
 *   必胜分 = WIN - ply（越快赢分越高，引导最短杀）
 *
 * ── 历史校准记录（15×15，Node 驱动，2026-09-12）─────────────────────
 *
 *   机机对战（邻档对比）：L2>L1 5-1、L3>L2 2-0、L4>L3 2-0、L5>L4 2-0、
 *   L6≈L5 2-2 —— 无档位倒挂。NPS 40k~110k。
 *
 *   修复记录：初版 vcfSearch 把"攻方双威胁必胜"判定放在"防方成五点
 *   反杀检查"之前——当防方有自己的成五点时，攻方的双四是假必胜
 *   （轮到防方直接五连）。曾导致 L6 连续输给 L5/L4。修复后先判反杀
 *   再判双威胁，梯度恢复正常。
 *
 * ── 消息协议 ─────────────────────────────────────────────────────────
 *
 *   入：{type:'search', seq, moves:[下标...], level:档位号}
 *   出：{type:'ready'}
 *       {type:'info', seq, depth, score, nodes, nps, timeMs, pv}
 *       {type:'result', seq, move, candidates:[{move,score}], forced, vcf,
 *        depth, nodes, nps, timeMs}
 *
 *   forced: 'win1' | 'block1' | 'none' —— 如实标注硬规则触发
 *   采样在主线程做（Difficulty.pickMove），引擎只负责给出带分的候选序列。
 *
 * @license MIT
 */

import { SIZE, AREA, EMPTY, BLACK, WHITE, CENTER, forbiddenReason, checkFive as winningLine } from '../rules.js';
import '../difficulty.js';

const engine = (function (global) {
  'use strict';

  // ── 基本常量 ─────────────────────────────────────────────────────────

  var WIN = 10000000;
  var WIN_THRESHOLD = 9000000;                     // |score| 超过即视为必胜/必败
  var INF = 1e15;
  var MAX_PLY = 40;                                // 搜索/杀棋的最大层数保险
  var TACTICAL_PLIES = 4;

  // 棋型分表（与文件头说明一致）
  var FIVE = 10000000, OPEN_FOUR = 1000000, FOUR = 100000;
  var OPEN_THREE = 90000, THREE = 3000;
  var OPEN_TWO = 2500, TWO = 300, ONE = 30;

  // 方向向量 [dc, dr]：横、竖、右下斜、右上斜
  var DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

  // ── 预计算表 ─────────────────────────────────────────────────────────

  // NBR9[d][idx]：沿方向 d 以 idx 为中心（位置 4）的 9 格下标，出界为 -1。
  // scorePoint 的滑动窗口直接在这里读，省掉边界判断。
  var NBR9 = [];
  for (var d0 = 0; d0 < 4; d0++) {
    var table = new Array(AREA);
    var dc0 = DIRS[d0][0], dr0 = DIRS[d0][1];
    for (var idx0 = 0; idx0 < AREA; idx0++) {
      var c0 = idx0 % SIZE, r0 = (idx0 / SIZE) | 0;
      var cells = new Int16Array(9);
      for (var k0 = -4; k0 <= 4; k0++) {
        var cc0 = c0 + dc0 * k0, rr0 = r0 + dr0 * k0;
        cells[k0 + 4] = (cc0 >= 0 && cc0 < SIZE && rr0 >= 0 && rr0 < SIZE)
          ? rr0 * SIZE + cc0 : -1;
      }
      table[idx0] = cells;
    }
    NBR9.push(table);
  }

  // LINES[d]：方向 d 的所有整线（短于五格的线评分为零）
  // lineNo[d][idx]：包含 idx 的线编号
  var LINES = [], lineNo = [], lineB = [], lineW = [];
  for (var d1 = 0; d1 < 4; d1++) {
    var dc1 = DIRS[d1][0], dr1 = DIRS[d1][1];
    var lines = [], refs = new Int16Array(AREA);
    for (var idx1 = 0; idx1 < AREA; idx1++) {
      var c1 = idx1 % SIZE, r1 = (idx1 / SIZE) | 0;
      var pc = c1 - dc1, pr = r1 - dr1;
      if (pc >= 0 && pc < SIZE && pr >= 0 && pr < SIZE) continue; // 不是线头
      var line = [];
      var cc1 = c1, rr1 = r1;
      while (cc1 >= 0 && cc1 < SIZE && rr1 >= 0 && rr1 < SIZE) {
        var i1 = rr1 * SIZE + cc1;
        line.push(i1);
        refs[i1] = lines.length;
        cc1 += dc1; rr1 += dr1;
      }
      lines.push(Int16Array.from(line));
    }
    LINES.push(lines);
    lineNo.push(refs);
    lineB.push(new Int32Array(lines.length));
    lineW.push(new Int32Array(lines.length));
  }

  // RING2[idx]：切比雪夫距离 ≤2 的邻域（不含自身），候选点生成的原料
  var RING2 = [];
  for (var idx2 = 0; idx2 < AREA; idx2++) {
    var c2 = idx2 % SIZE, r2 = (idx2 / SIZE) | 0;
    var ring = [];
    for (var dr2 = -2; dr2 <= 2; dr2++) {
      for (var dc2 = -2; dc2 <= 2; dc2++) {
        if (!dc2 && !dr2) continue;
        var cc2 = c2 + dc2, rr2 = r2 + dr2;
        if (cc2 >= 0 && cc2 < SIZE && rr2 >= 0 && rr2 < SIZE) ring.push(rr2 * SIZE + cc2);
      }
    }
    RING2.push(Int16Array.from(ring));
  }

  // ── Zobrist ─────────────────────────────────────────────────────────

  var ZOB1 = new Uint32Array(AREA * 3), ZOB2 = new Uint32Array(AREA * 3);
  (function () {
    // xorshift32，固定种子保证可复现
    var s = 20260911;
    function rnd() {
      s ^= s << 13; s |= 0;
      s ^= s >>> 17;
      s ^= s << 5; s |= 0;
      return s >>> 0;
    }
    for (var i = 0; i < AREA * 3; i++) { ZOB1[i] = rnd(); ZOB2[i] = rnd(); }
  })();

  // ── 置换表（1M 槽，always-replace）───────────────────────────────────

  var TT_SIZE = 1 << 20, TT_MASK = TT_SIZE - 1;
  var ttK1 = new Uint32Array(TT_SIZE), ttK2 = new Uint32Array(TT_SIZE);
  var ttDepth = new Int8Array(TT_SIZE);          // 存的深度，Int8 够（≤127）
  var ttFlag = new Uint8Array(TT_SIZE);          // 0=空 1=EXACT 2=LOWER 3=UPPER
  var ttScore = new Int32Array(TT_SIZE), ttMove = new Int16Array(TT_SIZE);

  // ── 局面状态 ─────────────────────────────────────────────────────────

  var board = new Int8Array(AREA);
  var moveStack = [];                 // 已落子下标序列（同时就是行棋历史）
  var sumB = 0, sumW = 0;             // 全盘黑/白棋型分（增量维护）
  var hash1 = 0, hash2 = 0;
  var pointB = new Int32Array(AREA), pointW = new Int32Array(AREA);

  // ── 评估：点评估与整线评估 ───────────────────────────────────────────

  /**
   * 点评估：假设在 idx 落 color 子后，四个方向的棋型分总和。
   * 落子是假想的（不真正写盘），中心格按 color 计。
   * 这是候选排序（进攻分 + 防守分×0.9）与硬规则检测的共用原语。
   */
  function scorePoint(idx, color) {
    var cache = color === BLACK ? pointB : pointW;
    if (cache[idx] >= 0) return cache[idx];
    var total = 0;
    for (var d = 0; d < 4; d++) {
      var cells = NBR9[d][idx];
      var five = false, e1 = -1, e2 = -1, three = 0, two = 0, one = 0;
      for (var w = 0; w < 5; w++) {
        var cnt = 0, emp = 0, empCell = -1, dead = false;
        for (var k = 0; k < 5; k++) {
          var ci = cells[w + k];
          if (ci < 0) { dead = true; break; }             // 出界 = 死窗口
          var v = ci === idx ? color : board[ci];          // 中心格视作已落子
          if (v === color) cnt++;
          else if (v === EMPTY) { emp++; empCell = ci; }
          else { dead = true; break; }                     // 对方子 = 死窗口
        }
        if (dead) continue;
        if (cnt === 5) five = true;
        else if (cnt === 4 && emp === 1) {
          // 成五完成点：互不相同的完成点计 2 个即为"活四级"双威胁
          if (empCell !== e1 && empCell !== e2) {
            if (e1 < 0) e1 = empCell; else e2 = empCell;
          }
        } else if (cnt === 3 && emp === 2) three++;
        else if (cnt === 2 && emp === 3) two++;
        else if (cnt === 1 && emp === 4) one++;
      }
      if (five) total += FIVE;
      else if (e2 >= 0) total += OPEN_FOUR;
      else if (e1 >= 0) total += FOUR;
      else if (three >= 2) total += OPEN_THREE;
      else if (three === 1) total += THREE;
      else if (two >= 2) total += OPEN_TWO;
      else if (two === 1) total += TWO;
      else if (one >= 1) total += ONE;
    }
    cache[idx] = total;
    return total;
  }

  // 只有包含变动点的五格窗口会变化；复用同一邻域表，落子/撤子均失效。
  function invalidatePoints(idx) {
    for (var d = 0; d < 4; d++) {
      var cells = NBR9[d][idx];
      for (var k = 0; k < cells.length; k++) {
        var p = cells[k];
        if (p >= 0) pointB[p] = pointW[p] = -1;
      }
    }
  }

  /**
   * 整线评估：一条线上 color 方的棋型分（与 scorePoint 同一套阶梯，
   * 保证排序与叶子评估的口径一致）。增量评估的最小工作单元。
   */
  function scoreLine(line, color) {
    var opp = color === BLACK ? WHITE : BLACK;
    var total = 0, start = 0;
    // 对手棋子隔开的棋型独立计分，两个眠三不能靠合并窗口升级成活三。
    for (var end = 0; end <= line.length; end++) {
      if (end < line.length && board[line[end]] !== opp) continue;
      var five = false, e1 = -1, e2 = -1, three = 0, two = 0, one = 0;
      for (var w = start; w + 5 <= end; w++) {
        var cnt = 0, empCell = -1;
        for (var k = 0; k < 5; k++) {
          var p = line[w + k];
          if (board[p] === color) cnt++;
          else empCell = p;
        }
        if (cnt === 5) five = true;
        else if (cnt === 4) {
          if (empCell !== e1 && empCell !== e2) {
            if (e1 < 0) e1 = empCell; else e2 = empCell;
          }
        } else if (cnt === 3) three++;
        else if (cnt === 2) two++;
        else if (cnt === 1) one++;
      }
      total += five ? FIVE : e2 >= 0 ? OPEN_FOUR : e1 >= 0 ? FOUR :
        three >= 2 ? OPEN_THREE : three === 1 ? THREE : two >= 2 ? OPEN_TWO : two === 1 ? TWO : one ? ONE : 0;
      start = end + 1;
    }
    return total;
  }

  /** 当前行棋方 */
  function toMove() { return moveStack.length % 2 === 0 ? BLACK : WHITE; }

  /** 叶子静态评估（行棋方视角） */
  function evalSide() {
    var score = moveStack.length % 2 === 0 ? sumB - sumW : sumW - sumB;
    // 静态棋型分不能冒充已证实的胜负。
    return Math.max(-WIN_THRESHOLD + 1, Math.min(WIN_THRESHOLD - 1, score));
  }

  // ── 落子 / 撤子（带增量评估与 Zobrist）──────────────────────────────

  function adjustLines(idx) {
    for (var d = 0; d < 4; d++) {
      var no = lineNo[d][idx], line = LINES[d][no];
      var b = scoreLine(line, BLACK), w = scoreLine(line, WHITE);
      sumB += b - lineB[d][no];
      sumW += w - lineW[d][no];
      lineB[d][no] = b; lineW[d][no] = w;
    }
  }

  function doMove(idx) {
    var color = toMove();
    board[idx] = color;
    invalidatePoints(idx);
    moveStack.push(idx);
    var zi = idx * 3 + color;
    hash1 = (hash1 ^ ZOB1[zi]) >>> 0;
    hash2 = (hash2 ^ ZOB2[zi]) >>> 0;
    adjustLines(idx); // 旧线分已缓存，只重算变化后的四条线。
  }

  function undoMove() {
    var idx = moveStack.pop();
    var color = board[idx];
    board[idx] = EMPTY;
    invalidatePoints(idx);
    var zi = idx * 3 + color;
    hash1 = (hash1 ^ ZOB1[zi]) >>> 0;
    hash2 = (hash2 ^ ZOB2[zi]) >>> 0;
    adjustLines(idx);
  }

  function checkFive(idx) {
    return winningLine(board, idx) !== null;
  }

  function legalPoint(idx, color) {
    return board[idx] === EMPTY && !forbiddenReason(board, idx, color);
  }

  // ── 候选点生成（时间戳去重，零分配）─────────────────────────────────

  var candStamp = new Int32Array(AREA), stampGen = 0;

  /**
   * 生成候选点：已有棋子切比雪夫距离 ≤2 的空点。
   * 空盘返回 H8。写入 out（Int16Array(AREA)），返回数量。
   */
  function genCandidates(out) {
    if (moveStack.length === 0) { out[0] = CENTER; return 1; }
    stampGen++;
    var n = 0;
    for (var m = 0; m < moveStack.length; m++) {
      var ring = RING2[moveStack[m]];
      for (var i = 0; i < ring.length; i++) {
        var c = ring[i];
        if (board[c] !== EMPTY || candStamp[c] === stampGen) continue;
        candStamp[c] = stampGen;
        out[n++] = c;
      }
    }
    return n;
  }

  // 每层的候选缓冲（避免父子层共用一个缓冲被冲掉）
  var CAND = [], KEYS = [], ATK = [], FOURS = [];
  for (var p0 = 0; p0 < MAX_PLY; p0++) {
    CAND.push(new Int16Array(AREA));
    KEYS.push(new Float64Array(AREA));
    ATK.push(new Float64Array(AREA));
    FOURS.push(new Int16Array(AREA));
  }

  // 供 fivePoints 用的临时缓冲
  var TMPA = new Int16Array(AREA);
  var FIVEBUF = new Int16Array(AREA);

  /**
   * 找出 color 方"一步成五"的所有空点（写进 FIVEBUF，返回数量）。
   * 根节点、内部强制攻防与 VCF 的防方反杀检查都靠它。
   */
  function fivePoints(color) {
    var n0 = genCandidates(TMPA);
    var cnt = 0;
    for (var i = 0; i < n0; i++) {
      if (scorePoint(TMPA[i], color) >= FIVE && legalPoint(TMPA[i], color)) FIVEBUF[cnt++] = TMPA[i];
    }
    return cnt;
  }

  // ── Negamax α-β（迭代加深的外壳在 searchRoot）───────────────────────

  var nodes = 0;
  var tacticalNodes = 0, useTactics = false, tacticalLimit = 0;
  var deadline = 0;
  var aborted = false;
  var ABORT = { abort: true };
  var VCF_ABORT = { vcf: true };
  var vcfDeadline = 0;
  var vcfStopReason = 'disabled';
  var rootWidth = 20, narrowWidth = 10;
  var history = new Float64Array(AREA);
  var killers = new Int16Array(MAX_PLY * 2);

  function now() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  function checkTime() {
    if (now() >= deadline) {
      aborted = true;
      throw ABORT;
    }
  }

  // 稳定地保留前 width 项，避免给最终不会搜索的候选做完整 O(n²) 排序。
  function orderCandidates(cands, keys, atk, n, width, side) {
    var kept = 0;
    for (var a = 0; a < n && width > 0; a++) {
      var km = keys[a], pm = cands[a], am = atk ? atk[a] : 0;
      if (kept === width && km <= keys[kept - 1]) continue;
      // 只校验有机会入选的点，禁手不占候选限额。
      if (!legalPoint(pm, side)) continue;
      var b = Math.min(kept, width - 1) - 1;
      while (b >= 0 && keys[b] < km) {
        keys[b + 1] = keys[b]; cands[b + 1] = cands[b];
        if (atk) atk[b + 1] = atk[b];
        b--;
      }
      keys[b + 1] = km; cands[b + 1] = pm;
      if (atk) atk[b + 1] = am;
      if (kept < width) kept++;
    }
    return kept;
  }

  function immediateThreat(side) {
    var opp = side === BLACK ? WHITE : BLACK;
    if ((side === BLACK ? sumB : sumW) >= FOUR && fivePoints(side) > 0) return { win: true };
    if ((opp === BLACK ? sumB : sumW) < FOUR) return null;
    var count = fivePoints(opp);
    if (!count) return null;
    if (count > 1 || !legalPoint(FIVEBUF[0], side)) return { lost: true };
    return { block: FIVEBUF[0] };
  }

  // 刚落 idx 后，新产生的成五补点必在它的四方向各四格内。
  function hasWinningReply(idx, side) {
    for (var d = 0; d < 4; d++) {
      var cells = NBR9[d][idx];
      for (var k = 0; k < cells.length; k++) {
        var p = cells[k];
        if (p >= 0 && board[p] === EMPTY && scorePoint(p, side) >= FIVE && legalPoint(p, side)) return true;
      }
    }
    return false;
  }

  function pickCandidates(ply, width, ttMove) {
    var side = toMove(), opp = side === BLACK ? WHITE : BLACK;
    var cands = CAND[ply], keys = KEYS[ply], atk = ATK[ply], fours = FOURS[ply];
    var total = genCandidates(cands), n = 0, nf = 0;
    for (var i = 0; i < total; i++) {
      if ((i & 31) === 0) {
        if (ply > 0) checkTime();
        else if (i > 0 && now() >= deadline) { aborted = true; break; }
      }
      var p = cands[i], a = scorePoint(p, side);
      if (useTactics && a >= FOUR) {
        if (!legalPoint(p, side)) continue;
        doMove(p);
        var forcing;
        try { forcing = hasWinningReply(p, side); }
        finally { undoMove(); }
        if (forcing) { fours[nf++] = p; continue; }
      }
      var key = a + scorePoint(p, opp) * 0.9;
      if (ply > 0) {
        if (p === ttMove) key += 1e9;
        else {
          if (p === killers[ply * 2] || p === killers[ply * 2 + 1]) key += 5e6;
          key += history[p];
        }
      }
      cands[n] = p; keys[n] = key; atk[n++] = a;
    }
    var kept = orderCandidates(cands, keys, atk, n, Math.max(0, width - nf), side);
    if (nf > 1) fours.subarray(0, nf).sort((a, b) => scorePoint(b, side) - scorePoint(a, side));
    cands.copyWithin(nf, 0, kept);
    atk.copyWithin(nf, 0, kept);
    for (var f = 0; f < nf; f++) { cands[f] = fours[f]; atk[f] = scorePoint(fours[f], side); }
    return nf + kept;
  }

  function tacticalSearch(alpha, beta, ply, remaining) {
    tacticalNodes++;
    if ((++nodes & 63) === 0) checkTime();
    var side = toMove(), threat = immediateThreat(side);
    if (threat && threat.win) return WIN - ply;
    if (threat && threat.lost) return -WIN + ply + 1;
    // ponytail: 战术延伸最多四手，更长变化由 VCF 和后续迭代处理。
    if (remaining === 0) return evalSide();
    if (threat) {
      doMove(threat.block);
      try { return -tacticalSearch(-beta, -alpha, ply + 1, remaining - 1); }
      finally { undoMove(); }
    }
    var best = evalSide();
    if (best >= beta) return best;
    if (best > alpha) alpha = best;
    var cands = CAND[ply], n = genCandidates(cands);
    for (var i = 0; i < n; i++) {
      if ((i & 31) === 0) checkTime();
      var p = cands[i];
      if (scorePoint(p, side) < FOUR || !legalPoint(p, side)) continue;
      doMove(p);
      try {
        if (hasWinningReply(p, side)) {
          var score = -tacticalSearch(-beta, -alpha, ply + 1, remaining - 1);
          if (score > best) best = score;
          if (best > alpha) alpha = best;
        }
      } finally {
        undoMove();
      }
      if (alpha >= beta) break;
    }
    return best;
  }

  function negamax(depth, alpha, beta, ply) {
    if (depth <= 0 && useTactics) return tacticalSearch(alpha, beta, ply, tacticalLimit);
    if ((++nodes & 63) === 0) checkTime();

    if (depth <= 0) return evalSide();
    var side = toMove(), threat = immediateThreat(side);
    if (threat && threat.win) return WIN - ply;
    if (threat && threat.lost) return -WIN + ply + 1;

    // 置换表探测
    var tti = hash1 & TT_MASK;
    var ttMv = -1;
    if (ttK1[tti] === hash1 && ttK2[tti] === hash2 && ttFlag[tti] !== 0) {
      ttMv = ttMove[tti];
      if (ttDepth[tti] >= depth) {
        var ts = ttScore[tti];
        // 必胜分按"距本节点的步数"存储，取出时换算回当前 ply（经典 mate 调整）
        if (ts > WIN_THRESHOLD) ts -= ply;
        else if (ts < -WIN_THRESHOLD) ts += ply;
        var fl = ttFlag[tti];
        if (fl === 1) return ts;
        if (fl === 2 && ts >= beta) return ts;
        if (fl === 3 && ts <= alpha) return ts;
      }
    }

    var cands = CAND[ply], atk = ATK[ply], width;
    if (threat) {
      cands[0] = threat.block; atk[0] = 0; width = 1;
    } else {
      width = pickCandidates(ply, ply < 2 ? rootWidth : narrowWidth, ttMv);
    }
    if (width === 0) return moveStack.length === AREA ? 0 : evalSide();

    var best = -INF, bestMove = -1;
    var alpha0 = alpha;

    for (var j = 0; j < width; j++) {
      var mv = cands[j];

      // 己方此点能直接成五：立刻赢，不必递归
      if (atk[j] >= FIVE) {
        best = WIN - ply;
        bestMove = mv;
        alpha = best;
        break;
      }

      doMove(mv);
      var s;
      try {
        if (checkFive(mv)) s = WIN - ply;
        else s = -negamax(depth - 1, -beta, -alpha, ply + 1);
      } finally {
        undoMove();
      }

      if (s > best) { best = s; bestMove = mv; }
      if (best > alpha) alpha = best;
      if (alpha >= beta) {
        // β 截断：记杀手、累计历史启发
        killers[ply * 2 + 1] = killers[ply * 2];
        killers[ply * 2] = mv;
        history[mv] += depth * depth;
        break;
      }
    }

    // 置换表存储
    var stored = best;
    if (stored > WIN_THRESHOLD) stored += ply;
    else if (stored < -WIN_THRESHOLD) stored -= ply;
    ttK1[tti] = hash1; ttK2[tti] = hash2;
    ttDepth[tti] = depth; ttMove[tti] = bestMove;
    ttScore[tti] = stored;
    ttFlag[tti] = best <= alpha0 ? 3 : (best >= beta ? 2 : 1);

    return best;
  }

  /** 从置换表里捞主线（展示用，最多 5 步） */
  function extractPv() {
    var pv = [];
    var made = 0;
    for (var step = 0; step < 5; step++) {
      var tti = hash1 & TT_MASK;
      if (ttK1[tti] !== hash1 || ttK2[tti] !== hash2 || ttFlag[tti] === 0) break;
      var mv = ttMove[tti];
      if (mv < 0 || board[mv] !== EMPTY) break;
      pv.push(mv);
      doMove(mv);
      made++;
    }
    for (var u = 0; u < made; u++) undoMove();
    return pv;
  }

  // ── VCF：连续冲四算杀 ───────────────────────────────────────────────

  var VCF_NODE_LIMIT = 200000;
  var VCF_MAX_PLY = 20;                        // 10 个冲四，足够覆盖常见杀型
  var vcfNodes = 0;

  function checkVcfTime() {
    checkTime();
    if (now() >= vcfDeadline) throw VCF_ABORT;
  }

  /**
   * 攻方只走"能形成四（含活四）"的点的深度优先搜索。
   * 防方的应手是被动推演的：
   *   - 防方若自己有成五点 → 攻方此路不通（防方直接赢）；
   *   - 攻方落子后若有 ≥2 个互不相同的成五点（活四/双四）→ 攻方必胜；
   *   - 否则防方唯一不输的应手是挡那个成五点（挡出防方五连的情形会被
   *     checkFive 检出并判此路不通）。
   * 返回 {move, ply}（ply = 取胜总步数，用于最短杀评分），未找到返回 null。
   */
  function vcfSearch(attacker, ply) {
    nodes++;
    checkVcfTime();
    if (++vcfNodes > VCF_NODE_LIMIT) { vcfStopReason = 'node-limit'; return null; }
    if (ply >= VCF_MAX_PLY) return null;

    var defender = attacker === BLACK ? WHITE : BLACK;

    // 攻方一步成五
    if (fivePoints(attacker) > 0) return { move: FIVEBUF[0], ply: ply + 1 };

    // 攻方所有能形成四的点（FOUR / OPEN_FOUR 都算）
    var n0 = genCandidates(TMPA);
    var fours = [];
    for (var i = 0; i < n0; i++) {
      var candidate = TMPA[i];
      if (scorePoint(candidate, attacker) < FOUR || !legalPoint(candidate, attacker)) continue;
      checkVcfTime();
      doMove(candidate);
      try { if (hasWinningReply(candidate, attacker)) fours.push(candidate); }
      finally { undoMove(); }
    }

    for (var f = 0; f < fours.length; f++) {
      checkVcfTime();
      var p = fours[f];
      doMove(p);
      try {
        // 防方有成五反杀时，攻方双威胁也不算必胜。
        if (fivePoints(defender) > 0) continue;
        var comps = fivePoints(attacker);
        if (comps >= 2) return { move: p, ply: ply + 3 };
        if (comps < 1) continue;
        var e = FIVEBUF[0];
        if (!legalPoint(e, defender)) return { move: p, ply: ply + 3 };

        doMove(e); // 防方必挡
        try {
          if (checkFive(e)) continue;
          var r = vcfSearch(attacker, ply + 2);
          if (r) return { move: p, ply: r.ply };
        } finally {
          undoMove();
        }
      } finally {
        undoMove();
      }
    }
    return null;
  }

  // ── 根节点搜索总装 ───────────────────────────────────────────────────

  function resetBoard(moves) {
    if (!Array.isArray(moves) || moves.length > AREA) throw new Error('invalid move list');
    board.fill(EMPTY);
    pointB.fill(-1); pointW.fill(-1);
    for (var d = 0; d < 4; d++) { lineB[d].fill(0); lineW[d].fill(0); }
    moveStack.length = 0;
    sumB = 0; sumW = 0;
    hash1 = 0; hash2 = 0;
    for (var i = 0; i < moves.length; i++) {
      var p = moves[i];
      if (!Number.isInteger(p) || p < 0 || p >= AREA || board[p] !== EMPTY) throw new Error('invalid move: ' + p);
      doMove(p);
    }
    // 每次新搜索重置启发表（跨局面残留没有意义）
    history.fill(0);
    killers.fill(0);
  }

  /**
   * 根搜索：合法硬应手 → 基础搜索 → 限时 VCF → 继续迭代加深。
   * 返回 {forced, vcf, candidates, depth, nodes, timeMs, pv}
   * candidates 按分降序；主线程拿去按难度采样。
   */
  function searchRoot(levelDef, onDepth, t0) {
    nodes = 0;
    tacticalNodes = 0;
    vcfNodes = 0;
    vcfStopReason = levelDef.vcf ? 'not-started' : 'disabled';
    aborted = false;
    deadline = t0 + levelDef.timeMs;
    if (useTactics !== levelDef.vcf || rootWidth !== levelDef.candWidth) ttFlag.fill(0);
    useTactics = levelDef.vcf;
    tacticalLimit = 0;
    rootWidth = levelDef.candWidth;
    narrowWidth = Math.max(8, levelDef.candWidth >> 1);

    var side = toMove();
    var opp = side === BLACK ? WHITE : BLACK;

    function finish(fields) {
      return { ...fields, nodes: nodes, tacticalNodes: tacticalNodes, vcfNodes: vcfNodes,
        vcfStopReason: vcfStopReason, timeMs: now() - t0 };
    }

    // 空盘直接下默认中央点
    if (moveStack.length === 0) {
      return finish({
        forced: 'none', vcf: false,
        candidates: [{ move: CENTER, score: 0 }],
        depth: 0, stopReason: 'opening', pv: [CENTER]
      });
    }

    // 硬规则①：己方一步成五 → 必走
    var n5 = fivePoints(side);
    if (n5 > 0) {
      return finish({
        forced: 'win1', vcf: false,
        candidates: [{ move: FIVEBUF[0], score: WIN }],
        depth: 0, stopReason: 'win1', pv: [FIVEBUF[0]]
      });
    }

    // 硬规则②：对方一步成五 → 必挡。多挡点浅搜比较（含"挡了顺便做四"）
    var no5 = fivePoints(opp);
    if (no5 > 0) {
      var blocks = [];
      for (var bi = 0; bi < no5; bi++) {
        if (legalPoint(FIVEBUF[bi], side)) blocks.push(FIVEBUF[bi]);
      }
      var bestBlock = blocks[0], bestScore = -INF, blockDepth = 0;
      for (var b = 0; b < blocks.length; b++) {
        doMove(blocks[b]);
        var s0 = -evalSide();
        try {
          checkTime();
          s0 = -negamax(2, -INF, INF, 1);
          blockDepth = 2;
        } catch (err) {
          if (err !== ABORT) throw err;
          if (blockDepth > 0) break; // 已有完整挡点评分时不混入超时后的静态分。
        } finally {
          undoMove();
        }
        if (s0 > bestScore) { bestScore = s0; bestBlock = blocks[b]; }
        if (aborted) break;
      }
      if (blocks.length) {
        return finish({
          forced: 'block1', vcf: false,
          candidates: [{ move: bestBlock, score: bestScore }],
          depth: blockDepth, stopReason: aborted ? 'time-limit' : 'block1', pv: [bestBlock]
        });
      }
    }

    // 先准备候选和静态分，保证 VCF 耗尽预算时仍有真实评估可返回。
    var cands = CAND[0], keys = KEYS[0];
    var width = pickCandidates(0, rootWidth, -1);
    if (width === 0 && moveStack.length < AREA) {
      // 局部邻域全为禁手时，扩大到整盘并按评分选合法着法。
      var n = 0;
      for (var empty = 0; empty < AREA; empty++) {
        if (board[empty] !== EMPTY) continue;
        cands[n] = empty;
        keys[n++] = scorePoint(empty, side) + scorePoint(empty, opp) * 0.9;
      }
      width = orderCandidates(cands, keys, null, n, Math.min(n, rootWidth), side);
    }

    var scores = new Array(width);
    for (var base = 0; base < width; base++) {
      doMove(cands[base]);
      scores[base] = -evalSide();
      undoMove();
    }
    var completedDepth = 0;
    var maxDepth = Math.min(MAX_PLY - TACTICAL_PLIES - 1, levelDef.depth > 0 ? levelDef.depth : MAX_PLY - TACTICAL_PLIES - 1);
    var stopReason = aborted ? 'time-limit' : width ? 'depth-limit' : 'no-move';

    for (var depth = 1; depth <= maxDepth && width > 0 && !aborted; depth++) {
      // 基础两层只识别立即胜负，完成后再投入额外战术延伸。
      tacticalLimit = depth > 2 ? TACTICAL_PLIES : 0;
      var iterationStart = now();
      var iterScores = new Array(width).fill(-INF);
      var alpha = -INF;
      try {
        for (var m2 = 0; m2 < width; m2++) {
          checkTime();
          var mv2 = cands[m2];
          doMove(mv2);
          var s2;
          try {
            if (checkFive(mv2)) s2 = WIN;
            else s2 = -negamax(depth - 1, -INF, -alpha, 1);
          } finally {
            undoMove();
          }
          iterScores[m2] = s2;
          if (s2 > alpha) alpha = s2;
        }
      } catch (err) {
        if (err !== ABORT) throw err;
        // 半层分数不可与上一层混排，保留最近完整层（未完成一层则用静态分）。
        stopReason = 'time-limit';
        break;
      }
      scores = iterScores;
      completedDepth = depth;
      reorderRoot(cands, scores, width);

      var bestScore2 = scores[0];
      var iterationTime = now() - iterationStart;
      if (onDepth) {
        onDepth({
          depth: depth, score: bestScore2, nodes: nodes, tacticalNodes: tacticalNodes, vcfNodes: vcfNodes,
          timeMs: now() - t0, pv: extractPv()
        });
      }
      if (Math.abs(bestScore2) >= WIN_THRESHOLD) { stopReason = 'proven'; break; }

      // 先有完整基础搜索，再让 VCF 使用有限子预算；VCF 超时不终止普通搜索。
      if (levelDef.vcf && depth === Math.min(2, maxDepth)) {
        var vcfStart = now();
        vcfDeadline = vcfStart + Math.min(400, Math.max(0, deadline - vcfStart) * 0.2);
        vcfStopReason = 'not-found';
        try {
          var vr = vcfSearch(side, 0);
          if (vr) {
            vcfStopReason = 'found';
            return finish({
              forced: 'none', vcf: true,
              candidates: [{ move: vr.move, score: WIN - vr.ply }],
              depth: vr.ply, stopReason: 'vcf', pv: [vr.move]
            });
          }
        } catch (err) {
          if (err !== ABORT && err !== VCF_ABORT) throw err;
          vcfStopReason = err === VCF_ABORT ? 'time-limit' : 'total-time-limit';
        }
      }
      if (aborted) { stopReason = 'time-limit'; break; }
      if (depth >= 2 && depth < maxDepth && deadline - now() < iterationTime) {
        stopReason = 'time-estimate';
        break;
      }
    }

    reorderRoot(cands, scores, width);
    var candidatesOut = [];
    for (var o = 0; o < width; o++) {
      candidatesOut.push({ move: cands[o], score: Math.round(scores[o]) });
    }
    return finish({
      forced: 'none', vcf: false,
      candidates: candidatesOut,
      depth: completedDepth, stopReason: stopReason, pv: extractPv()
    });
  }

  /** 根候选按最新分数重排（最佳前置，下一轮优先搜） */
  function reorderRoot(cands, scores, width) {
    for (var a = 1; a < width; a++) {
      var sm = scores[a], pm = cands[a], b = a - 1;
      while (b >= 0 && scores[b] < sm) { scores[b + 1] = scores[b]; cands[b + 1] = cands[b]; b--; }
      scores[b + 1] = sm; cands[b + 1] = pm;
    }
  }

  // ── 消息协议 ─────────────────────────────────────────────────────────

  function handleSearch(msg) {
    var t0 = now();
    var def = global.Difficulty.getLevel(msg.level);
    var res;
    try {
      resetBoard(msg.moves);
      res = searchRoot(def, function (info) {
        global.postMessage({
          type: 'info', seq: msg.seq,
          depth: info.depth, score: info.score, nodes: info.nodes, tacticalNodes: info.tacticalNodes, vcfNodes: info.vcfNodes,
          nps: info.timeMs > 0 ? Math.round(info.nodes / (info.timeMs / 1000)) : 0,
          timeMs: Math.round(info.timeMs), pv: info.pv
        });
      }, t0);
    } catch (err) {
      global.postMessage({ type: 'error', seq: msg.seq, message: String(err && err.stack || err) });
      return;
    }
    var timeMs = Math.max(1, Math.round(res.timeMs));
    global.postMessage({
      type: 'result', seq: msg.seq,
      move: res.candidates.length ? res.candidates[0].move : null,
      candidates: res.candidates,
      forced: res.forced, vcf: res.vcf,
      depth: res.depth, nodes: res.nodes, tacticalNodes: res.tacticalNodes, vcfNodes: res.vcfNodes,
      vcfStopReason: res.vcfStopReason, stopReason: res.stopReason,
      nps: Math.round(res.nodes / (timeMs / 1000)),
      timeMs: timeMs, pv: res.pv
    });
  }

  if (typeof global.addEventListener === 'function') {
    global.addEventListener('message', function (ev) {
      if (ev.data && ev.data.type === 'search') handleSearch(ev.data);
    });
    global.postMessage({ type: 'ready' });
  }

  // ── Node 默认导出：直接驱动同一引擎做回归与成对对弈 ────────────────

  var api = {
    SIZE: SIZE, AREA: AREA, CENTER: CENTER,
    scorePoint: function (idx, color, moves) { resetBoard(moves || []); return scorePoint(idx, color); },
    checkFive: function (idx, moves) { resetBoard(moves || []); return checkFive(idx); },
    genCandidateCount: function (moves) { resetBoard(moves || []); return genCandidates(TMPA); },
    vcf: function (moves) {
      resetBoard(moves || []);
      nodes = 0; vcfNodes = 0; aborted = false;
      deadline = now() + global.Difficulty.getLevel(6).timeMs;
      vcfDeadline = deadline;
      try { return vcfSearch(toMove(), 0); }
      catch (err) { if (err !== ABORT && err !== VCF_ABORT) throw err; return null; }
    },
    search: function (moves, level, onDepth) {
      var t0 = now();
      resetBoard(moves || []);
      return searchRoot(global.Difficulty.getLevel(level), onDepth, t0);
    },
    evalBoard: function (moves) {
      resetBoard(moves || []);
      return { black: sumB, white: sumW, side: evalSide() };
    }
  };

  return api;

})(globalThis);

export default engine;
