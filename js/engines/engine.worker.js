/**
 * engine.worker.js - 自研五子棋引擎（Web Worker）
 *
 * ── 算法组成 ──────────────────────────────────────────────────────────
 *
 *   根节点硬规则（任何档位都生效，见 difficulty.js 的"不可弱化的硬底线"）
 *     ① 己方任一空点能直接成五 → 立即落子（零搜索）
 *     ② 对方任一空点能直接成五 → 只在挡点里挑（快速浅搜比较挡点）
 *   ↓ 都不触发时
 *   VCF 算杀（档位开启时）：只走"冲四"的深度优先搜索，找到必胜连线直接返回
 *   ↓ 未命中
 *   迭代加深 Negamax α-β：
 *     - Zobrist 置换表（双 32 位键校验，深度优先替换）
 *     - 杀手启发（每层 2 个）+ 历史启发（β 截断次数 × 深度²）
 *     - 候选点 = 已有棋子切比雪夫距离 ≤2 的空点，按"进攻分 + 防守分×0.9"排序
 *     - 浅层取前 candWidth 个，深层收窄一半（下限 8）
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
 * 全局黑分 sumB / 白分 sumW 常驻内存，叶子评估 O(1)。
 *
 * ── 分数刻度（difficulty.js 的温度/损失上限按这个刻度调的）──────────
 *
 *   FIVE=10,000,000  OPEN_FOUR=1,000,000  FOUR=100,000
 *   OPEN_THREE=90,000  THREE=3,000  OPEN_TWO=2,500  TWO=300  ONE=30
 *   必胜分 = WIN - ply（越快赢分越高，引导最短杀）
 *
 * ── 校准记录（Node 驱动实测，2026-09-12）────────────────────────────
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

(function (global) {
  'use strict';

  // 引擎 Worker 需要读难度档位定义（深度/时限/候选宽度/VCF 开关）
  if (typeof importScripts === 'function') {
    importScripts('../difficulty.js');
  }

  // ── 基本常量 ─────────────────────────────────────────────────────────

  var SIZE = 15, AREA = SIZE * SIZE;
  var EMPTY = 0, BLACK = 1, WHITE = 2;
  var CENTER = 7 * SIZE + 7;                       // 天元 H8
  var WIN = 10000000;
  var WIN_THRESHOLD = 9000000;                     // |score| 超过即视为必胜/必败
  var INF = 1e15;
  var MAX_PLY = 40;                                // 搜索/杀棋的最大层数保险

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

  // LINES[d]：方向 d 的所有整线（长度 5~15 的下标序列）
  // lineNo[d][idx]：包含 idx 的线编号
  var LINES = [], lineNo = [];
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

  // ── 评估：点评估与整线评估 ───────────────────────────────────────────

  /**
   * 点评估：假设在 idx 落 color 子后，四个方向的棋型分总和。
   * 落子是假想的（不真正写盘），中心格按 color 计。
   * 这是候选排序（进攻分 + 防守分×0.9）与硬规则检测的共用原语。
   */
  function scorePoint(idx, color) {
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
    return total;
  }

  /**
   * 整线评估：一条线上 color 方的棋型分（与 scorePoint 同一套阶梯，
   * 保证排序与叶子评估的口径一致）。增量评估的最小工作单元。
   */
  function scoreLine(line, color) {
    var n = line.length;
    var five = false, e1 = -1, e2 = -1, three = 0, two = 0, one = 0;
    for (var w = 0; w + 5 <= n; w++) {
      var cnt = 0, emp = 0, empCell = -1, dead = false;
      for (var k = 0; k < 5; k++) {
        var v = board[line[w + k]];
        if (v === color) cnt++;
        else if (v === EMPTY) { emp++; empCell = line[w + k]; }
        else { dead = true; break; }
      }
      if (dead) continue;
      if (cnt === 5) five = true;
      else if (cnt === 4 && emp === 1) {
        if (empCell !== e1 && empCell !== e2) {
          if (e1 < 0) e1 = empCell; else e2 = empCell;
        }
      } else if (cnt === 3 && emp === 2) three++;
      else if (cnt === 2 && emp === 3) two++;
      else if (cnt === 1 && emp === 4) one++;
    }
    if (five) return FIVE;
    if (e2 >= 0) return OPEN_FOUR;
    if (e1 >= 0) return FOUR;
    if (three >= 2) return OPEN_THREE;
    if (three === 1) return THREE;
    if (two >= 2) return OPEN_TWO;
    if (two === 1) return TWO;
    return one >= 1 ? ONE : 0;
  }

  /** 当前行棋方 */
  function toMove() { return moveStack.length % 2 === 0 ? BLACK : WHITE; }

  /** 叶子静态评估（行棋方视角） */
  function evalSide() {
    return moveStack.length % 2 === 0 ? sumB - sumW : sumW - sumB;
  }

  // ── 落子 / 撤子（带增量评估与 Zobrist）──────────────────────────────

  function adjustLines(idx, sign) {
    for (var d = 0; d < 4; d++) {
      var line = LINES[d][lineNo[d][idx]];
      sumB += sign * scoreLine(line, BLACK);
      sumW += sign * scoreLine(line, WHITE);
    }
  }

  function doMove(idx) {
    var color = toMove();
    adjustLines(idx, -1);                      // 先减旧线分
    board[idx] = color;
    moveStack.push(idx);
    var zi = idx * 3 + color;
    hash1 = (hash1 ^ ZOB1[zi]) >>> 0;
    hash2 = (hash2 ^ ZOB2[zi]) >>> 0;
    adjustLines(idx, 1);                       // 再加新线分
  }

  function undoMove() {
    var idx = moveStack.pop();
    var color = board[idx];
    adjustLines(idx, -1);
    board[idx] = EMPTY;
    var zi = idx * 3 + color;
    hash1 = (hash1 ^ ZOB1[zi]) >>> 0;
    hash2 = (hash2 ^ ZOB2[zi]) >>> 0;
    adjustLines(idx, 1);
  }

  /**
   * 五连/长连判定：只从落点出发向 4 个方向数（之前没赢现在才可能刚赢）。
   * 与主线程 rules.js 的 checkFive 逻辑一致（Worker 不能 import ES 模块，故内联一份）。
   */
  function checkFive(idx) {
    var color = board[idx];
    if (color === EMPTY) return false;
    var c0 = idx % SIZE, r0 = (idx / SIZE) | 0;
    for (var d = 0; d < 4; d++) {
      var dc = DIRS[d][0], dr = DIRS[d][1];
      var count = 1;
      for (var c = c0 + dc, r = r0 + dr; c >= 0 && c < SIZE && r >= 0 && r < SIZE && board[r * SIZE + c] === color; c += dc, r += dr) count++;
      for (var c2 = c0 - dc, r2 = r0 - dr; c2 >= 0 && c2 < SIZE && r2 >= 0 && r2 < SIZE && board[r2 * SIZE + c2] === color; c2 -= dc, r2 -= dr) count++;
      if (count >= 5) return true;
    }
    return false;
  }

  // ── 候选点生成（时间戳去重，零分配）─────────────────────────────────

  var candStamp = new Int32Array(AREA), stampGen = 0;

  /**
   * 生成候选点：已有棋子切比雪夫距离 ≤2 的空点。
   * 空盘返回天元。写入 out（Int16Array(AREA)），返回数量。
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
  var CAND = [], KEYS = [], ATK = [];
  for (var p0 = 0; p0 < MAX_PLY; p0++) {
    CAND.push(new Int16Array(AREA));
    KEYS.push(new Float64Array(AREA));
    ATK.push(new Float64Array(AREA));
  }

  // 供 fivePoints 用的临时缓冲
  var TMPA = new Int16Array(AREA);
  var FIVEBUF = new Int16Array(AREA);

  /**
   * 找出 color 方"一步成五"的所有空点（写进 FIVEBUF，返回数量）。
   * 根节点硬规则①②与 VCF 的防方反杀检查都靠它。
   */
  function fivePoints(color) {
    var n0 = genCandidates(TMPA);
    var cnt = 0;
    for (var i = 0; i < n0; i++) {
      if (scorePoint(TMPA[i], color) >= FIVE) FIVEBUF[cnt++] = TMPA[i];
    }
    return cnt;
  }

  // ── Negamax α-β（迭代加深的外壳在 searchRoot）───────────────────────

  var nodes = 0;
  var deadline = 0;
  var aborted = false;
  var ABORT = { abort: true };
  var rootWidth = 20, narrowWidth = 10;
  var history = new Float64Array(AREA);
  var killers = new Int16Array(MAX_PLY * 2);

  function now() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  function negamax(depth, alpha, beta, ply) {
    if ((++nodes & 1023) === 0 && now() > deadline) {
      aborted = true;
      throw ABORT;
    }

    if (depth <= 0) return evalSide();

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

    var side = toMove();
    var opp = side === BLACK ? WHITE : BLACK;
    var cands = CAND[ply], keys = KEYS[ply], atk = ATK[ply];
    var n = genCandidates(cands);
    if (n === 0) return 0;                      // 满盘

    // 打分：进攻 1.0 + 防守 0.9，TT 着法最优先，杀手/历史次之
    for (var i = 0; i < n; i++) {
      var p = cands[i];
      var a = scorePoint(p, side);
      atk[i] = a;
      var k = a + scorePoint(p, opp) * 0.9;
      if (p === ttMv) k += 1e9;
      else {
        if (p === killers[ply * 2] || p === killers[ply * 2 + 1]) k += 5e6;
        k += history[p];
      }
      keys[i] = k;
    }

    // 插入排序（按 key 降序，n 通常 30~80，足够快）
    for (var a2 = 1; a2 < n; a2++) {
      var km = keys[a2], pm = cands[a2], am = atk[a2];
      var b2 = a2 - 1;
      while (b2 >= 0 && keys[b2] < km) {
        keys[b2 + 1] = keys[b2]; cands[b2 + 1] = cands[b2]; atk[b2 + 1] = atk[b2];
        b2--;
      }
      keys[b2 + 1] = km; cands[b2 + 1] = pm; atk[b2 + 1] = am;
    }

    var width = Math.min(n, ply < 2 ? rootWidth : narrowWidth);

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
      if (checkFive(mv)) s = WIN - ply;
      else s = -negamax(depth - 1, -beta, -alpha, ply + 1);
      undoMove();

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
    if (++vcfNodes > VCF_NODE_LIMIT) return null;
    if (ply >= VCF_MAX_PLY) return null;

    var defender = attacker === BLACK ? WHITE : BLACK;

    // 攻方一步成五
    if (fivePoints(attacker) > 0) return { move: FIVEBUF[0], ply: ply };

    // 攻方所有能形成四的点（FOUR / OPEN_FOUR 都算）
    var n0 = genCandidates(TMPA);
    var fours = [];
    for (var i = 0; i < n0; i++) {
      if (scorePoint(TMPA[i], attacker) >= FOUR) fours.push(TMPA[i]);
    }

    for (var f = 0; f < fours.length; f++) {
      var p = fours[f];
      doMove(p);

      // ★ 必须先判防方反杀，再判攻方双威胁：落完这颗子轮到的是防方，
      //   防方若有自己的成五点会立刻赢——"双四必胜"在防方反杀面前是假的。
      //   （校准对局里 L5 正是靠这个反杀赢了声称 VCF 必胜的 L6。）
      if (fivePoints(defender) > 0) { undoMove(); continue; }             // 防方有反杀，此四无效

      // 落子后的成五点集合（此时包含刚落的子）
      var comps = fivePoints(attacker);
      if (comps >= 2) { undoMove(); return { move: p, ply: ply + 1 }; }   // 双威胁必胜

      if (comps < 1) { undoMove(); continue; }                            // 理论不会发生，保险
      var e = FIVEBUF[0];

      doMove(e);                                                          // 防方必挡
      if (checkFive(e)) { undoMove(); undoMove(); continue; }             // 挡出了防方五连

      var r = vcfSearch(attacker, ply + 2);
      undoMove();
      undoMove();
      if (r) return { move: p, ply: r.ply };
    }
    return null;
  }

  // ── 根节点搜索总装 ───────────────────────────────────────────────────

  function resetBoard(moves) {
    board.fill(EMPTY);
    moveStack.length = 0;
    sumB = 0; sumW = 0;
    hash1 = 0; hash2 = 0;
    for (var i = 0; i < moves.length; i++) doMove(moves[i]);
    // 每次新搜索重置启发表（跨局面残留没有意义）
    history.fill(0);
    killers.fill(0);
  }

  /**
   * 根搜索：硬规则 → VCF → 迭代加深。
   * 返回 {forced, vcf, candidates, depth, nodes, timeMs, pv}
   * candidates 按分降序；主线程拿去按难度采样。
   */
  function searchRoot(levelDef, onDepth) {
    var t0 = now();
    nodes = 0;
    vcfNodes = 0;
    aborted = false;
    deadline = t0 + levelDef.timeMs;
    rootWidth = levelDef.candWidth;
    narrowWidth = Math.max(8, levelDef.candWidth >> 1);

    var side = toMove();
    var opp = side === BLACK ? WHITE : BLACK;

    // 空盘直接下天元
    if (moveStack.length === 0) {
      return {
        forced: 'none', vcf: false,
        candidates: [{ move: CENTER, score: 0 }],
        depth: 0, nodes: 0, timeMs: now() - t0, pv: [CENTER]
      };
    }

    // 硬规则①：己方一步成五 → 必走
    var n5 = fivePoints(side);
    if (n5 > 0) {
      return {
        forced: 'win1', vcf: false,
        candidates: [{ move: FIVEBUF[0], score: WIN }],
        depth: 0, nodes: 0, timeMs: now() - t0, pv: [FIVEBUF[0]]
      };
    }

    // 硬规则②：对方一步成五 → 必挡。多挡点浅搜比较（含"挡了顺便做四"）
    var no5 = fivePoints(opp);
    if (no5 > 0) {
      var blocks = [];
      for (var bi = 0; bi < no5; bi++) blocks.push(FIVEBUF[bi]);
      var bestBlock = blocks[0], bestScore = -INF;
      for (var b = 0; b < blocks.length; b++) {
        doMove(blocks[b]);
        var s0;
        try { s0 = -negamax(2, -INF, INF, 1); } catch (err) { if (err !== ABORT) throw err; s0 = -INF; }
        undoMove();
        if (s0 > bestScore) { bestScore = s0; bestBlock = blocks[b]; }
      }
      return {
        forced: 'block1', vcf: false,
        candidates: [{ move: bestBlock, score: bestScore }],
        depth: 2, nodes: nodes, timeMs: now() - t0, pv: [bestBlock]
      };
    }

    // VCF 算杀（档位开启时）
    if (levelDef.vcf) {
      var vr = vcfSearch(side, 0);
      if (vr) {
        var elapsed = now() - t0;
        return {
          forced: 'none', vcf: true,
          candidates: [{ move: vr.move, score: WIN - vr.ply }],
          depth: vr.ply, nodes: nodes, timeMs: elapsed, pv: [vr.move]
        };
      }
    }

    // 迭代加深 α-β
    var cands = CAND[0], keys = KEYS[0];
    var n = genCandidates(cands);
    var side2 = toMove(), opp2 = side2 === BLACK ? WHITE : BLACK;
    for (var q = 0; q < n; q++) {
      keys[q] = scorePoint(cands[q], side2) + scorePoint(cands[q], opp2) * 0.9;
    }
    // 插入排序取前 rootWidth
    for (var a3 = 1; a3 < n; a3++) {
      var km3 = keys[a3], pm3 = cands[a3], b3 = a3 - 1;
      while (b3 >= 0 && keys[b3] < km3) { keys[b3 + 1] = keys[b3]; cands[b3 + 1] = cands[b3]; b3--; }
      keys[b3 + 1] = km3; cands[b3 + 1] = pm3;
    }
    var width = Math.min(n, rootWidth);

    // 每个根候选的当前分。先给 0 兜底：depth=1 的入门档只跑一轮
    // "落子后看静态分"（贪心），不进后续迭代，保证任何档位都有确定分数。
    var scores = new Array(width).fill(0);
    var completedDepth = 0;
    var maxDepth = levelDef.depth > 0 ? levelDef.depth : 64;

    for (var depth = 1; depth <= maxDepth; depth++) {
      var iterScores = new Array(width).fill(-INF);
      var alpha = -INF;
      aborted = false;
      try {
        for (var m2 = 0; m2 < width; m2++) {
          var mv2 = cands[m2];
          doMove(mv2);
          var s2;
          if (checkFive(mv2)) s2 = WIN;
          else s2 = -negamax(depth - 1, -INF, -alpha, 1);
          undoMove();
          iterScores[m2] = s2;
          if (s2 > alpha) alpha = s2;
        }
      } catch (err) {
        if (err !== ABORT) throw err;
        // 半截迭代：已搜完的候选分数是精确的（root 全窗口起算，
        // 超过 alpha 的值未经过剪枝截断），没搜到的保留上一轮的
        for (var m3 = 0; m3 < width; m3++) {
          if (iterScores[m3] === -INF) iterScores[m3] = completedDepth > 0 ? scores[m3] : 0;
        }
        scores = iterScores;
        reorderRoot(cands, scores, width);
        completedDepth = depth - 1;   // 完成的是上一轮
        break;
      }
      scores = iterScores;
      completedDepth = depth;
      reorderRoot(cands, scores, width);

      var bestScore2 = scores[0];
      var elapsed2 = now() - t0;
      if (onDepth) {
        onDepth({
          depth: depth, score: bestScore2, nodes: nodes,
          timeMs: elapsed2, pv: extractPv()
        });
      }
      // 已见必胜/必败或时间将尽，不必再加深
      if (Math.abs(bestScore2) >= WIN_THRESHOLD) break;
      if (elapsed2 > levelDef.timeMs * 0.5) break;   // 下一轮大概率超时
    }

    var candidatesOut = [];
    for (var o = 0; o < width; o++) {
      candidatesOut.push({ move: cands[o], score: Math.round(scores[o]) });
    }
    // 保险：理论上不该有无分候选，兜底给 0
    return {
      forced: 'none', vcf: false,
      candidates: candidatesOut,
      depth: completedDepth, nodes: nodes,
      timeMs: now() - t0, pv: extractPv()
    };
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
    resetBoard(msg.moves || []);
    var def = global.Difficulty.getLevel(msg.level);
    var res;
    try {
      res = searchRoot(def, function (info) {
        global.postMessage({
          type: 'info', seq: msg.seq,
          depth: info.depth, score: info.score, nodes: info.nodes,
          nps: info.timeMs > 0 ? Math.round(info.nodes / (info.timeMs / 1000)) : 0,
          timeMs: Math.round(info.timeMs), pv: info.pv
        });
      });
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
      depth: res.depth, nodes: res.nodes,
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

  // ── Node 调试出口（难度校准/逻辑验证用，浏览器里不触达）────────────

  var api = {
    SIZE: SIZE, AREA: AREA, CENTER: CENTER,
    scorePoint: function (idx, color, moves) { resetBoard(moves || []); return scorePoint(idx, color); },
    checkFive: function (idx, moves) { resetBoard(moves || []); return checkFive(idx); },
    genCandidateCount: function (moves) { resetBoard(moves || []); return genCandidates(TMPA); },
    vcf: function (moves) { resetBoard(moves || []); vcfNodes = 0; return vcfSearch(toMove(), 0); },
    search: function (moves, level, onDepth) {
      resetBoard(moves || []);
      return searchRoot(global.Difficulty.getLevel(level), onDepth);
    },
    evalBoard: function (moves) {
      resetBoard(moves || []);
      return { black: sumB, white: sumW, side: evalSide() };
    }
  };

  global.__GomokuEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
