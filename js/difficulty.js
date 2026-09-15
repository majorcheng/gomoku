/**
 * difficulty.js - 难度档位的单一事实来源
 *
 * 这个文件只描述"什么档位用什么参数"，以及"拿到引擎候选落子后怎么挑一步"。
 * 它不碰 DOM、不碰 Worker 消息，只暴露一个全局对象 Difficulty。
 * 主线程用 <script> 加载；模块 Worker 用 import 加载——两边读同一份定义，
 * 杜绝"同一条难度规则散落在多个文件"。
 *
 * ── 与 02/03 的差异 ───────────────────────────────────────────────────
 *
 * 国际象棋那边靠 Stockfish 原生的 UCI_LimitStrength / UCI_Elo 弱化引擎；
 * 本项目引擎是自研的，所以难度旋钮直接映射到引擎参数上：
 *
 *   1) 搜索弱化（"能看多远"）：
 *      depth      - 迭代加深的深度上限（0 表示只受时间限制）
 *      timeMs     - 整手搜索预算（检查点之间可能有少量超时）
 *      candWidth  - 每层参与排序的候选点数量上限（分支因子控制）
 *      vcf        - 是否启用 VCF 连续冲四算杀（低档关掉，让玩家有机会做杀）
 *
 *   2) 根节点采样（"看准了会不会走歪"）：
 *      temperature - softmax 温度（评估分单位）。0 = 永远走引擎首选
 *      blunder     - 触发"从更宽的池子里随机挑一步"的概率
 *
 * ── 不可弱化的硬底线（防"看起来像 bug"）──────────────────────────────
 *
 * 不论什么档位，引擎根节点始终执行：
 *   ① 己方任一点能直接成五 → 必走（放着五连不赢不叫菜，叫坏了）；
 *   ② 对方任一点能直接成五 → 必挡（含己方反冲四的比较，交给搜索）。
 * 这两条在 engine.worker.js 里实现，采样层永远碰不到它们，
 * 所以低档位再弱也不会出现"送对方五连"的名场面。
 *
 * 此外采样带损失上限：候选分差超过档位上限时强制回引擎首选，
 * 避免"放着活四不冲、去填一个无关的角"这种不像弱、像坏的落子。
 *
 * ── 分数刻度 ─────────────────────────────────────────────────────────
 *
 * 本引擎的评估分单位见 engine.worker.js 的棋型表：五连 10,000,000、
 * 活四 1,000,000、冲四 100,000、活三 90,000……根节点不同落子的分差
 * 常见量级在千到几万之间，所以温度与损失上限都用"万"做单位调的。
 *
 * ── 历史校准记录（15×15；30×30 基准见 README_CN.md）─────────────────
 *
 * 2026-09-12 Node 驱动机机对战（每对先 4 局换先；邻档对比）：
 *
 *   L2 vs L1 : 5-1（6 局制）→ 无倒挂
 *   L3 vs L2 : 2-0
 *   L4 vs L3 : 2-0
 *   L5 vs L4 : 2-0
 *   L6 vs L5 : 2-2（宗师 4s 时限下与大师互有胜负，梯度可接受）
 *   L2 vs L1 补测 4 局 : 2-2（低档采样随机性大，属预期）
 *
 * 中局单步耗时（14 手开阔局面，3 次平均）：
 *   L1 ~1ms / L2 ~2ms / L3 ~30ms / L4 ~70ms；L5/L6 受时间上限与
 *   必胜分提前终止影响波动大，自对局平均每手 ~1-2s（L6 局均 ~70s）。
 *   NPS 实测 40k~110k（纯 JS，候选点评估占大头）。
 *
 * 期间修复过一个关键 bug：VCF 的"双威胁必胜"判定原在防方反杀检查
 * 之前执行，导致假必胜（L6 曾因此连输 L5/L4）；修复后顺序为
 * 先判防方成五点、再判双威胁，见 engine.worker.js 的 vcfSearch。
 *
 * @license MIT
 */

(function (global) {
  'use strict';

  var ENGINE = 'gomoku-ab-vcf';

  /**
   * 采样时允许的最大分差（评估分单位）。
   * 档位越低放得越宽，但始终有上限；超过上限的候选直接丢弃。
   */
  var LOSS_CAP = {
    1: 60000,
    2: 40000,
    3: 20000,
    4: 10000
  };

  /** 失误模式下允许的最大分差（比正常采样更宽，但仍有底） */
  var BLUNDER_CAP = 90000;

  /** 必胜分阈值：分值达到这个量级说明搜索已找到强制获胜 */
  var WIN_BASE = 9000000;

  /**
   * 六档难度。
   *
   * 字段说明：
   *   label       - 显示名，UI 的难度按钮文案直接读它，不要另外硬编码
   *   depth       - 迭代加深深度上限；0 表示只按时间搜
   *   timeMs      - VCF 与 α-β 共用的搜索时间预算
   *   candWidth   - 每层候选宽度（浅层）；深层自动收窄到 max(8, candWidth/2)
   *   vcf         - 是否启用 VCF 算杀（连续冲四取胜搜索）
   *   temperature - softmax 温度（评估分单位）；0 表示永远取引擎首选
   *   blunder     - 在更宽的候选池里随机挑一步的概率（0~1）
   *   desc        - 档位描述（难度选择菜单展示）
   */
  var LEVELS = [
    { level: 1, label: '入门', depth: 1, timeMs: 200,  candWidth: 12, vcf: false, temperature: 25000, blunder: 0.30,
      desc: '只看一步，还经常走歪。刚学会规则也能赢它。' },
    { level: 2, label: '初级', depth: 2, timeMs: 500,  candWidth: 16, vcf: false, temperature: 10000, blunder: 0.12,
      desc: '能看见两步内的攻防，会漏掉慢一步的威胁。' },
    { level: 3, label: '中级', depth: 4, timeMs: 1000, candWidth: 20, vcf: false, temperature: 3000,  blunder: 0.02,
      desc: '有基本攻防意识，四层搜索，偶尔失手。' },
    { level: 4, label: '高级', depth: 6, timeMs: 1500, candWidth: 24, vcf: true,  temperature: 1200,  blunder: 0,
      desc: '六层搜索 + 限时冲四算杀，优先处理强制攻防。' },
    { level: 5, label: '大师', depth: 8, timeMs: 2500, candWidth: 32, vcf: true,  temperature: 0,     blunder: 0,
      desc: '八层搜索 + 战术延伸，时间预算 2.5 秒。' },
    { level: 6, label: '宗师', depth: 12, timeMs: 4000, candWidth: 32, vcf: true,  temperature: 0,    blunder: 0,
      desc: '12 层上限 + 战术延伸，时间预算 4 秒。' }
  ];

  var DEFAULT_LEVEL = 3;

  /** 允许"档位号"或"档位定义对象"两种入参 */
  function resolveDef(levelOrDef) {
    if (levelOrDef && typeof levelOrDef === 'object') return levelOrDef;
    return getLevel(levelOrDef);
  }

  /** 按档位号取定义；越界回落到默认档位 */
  function getLevel(level) {
    for (var i = 0; i < LEVELS.length; i++) {
      if (LEVELS[i].level === level) return LEVELS[i];
    }
    return getLevel(DEFAULT_LEVEL);
  }

  /** 候选是否是"已找到强制获胜"的落子（分值达到必胜量级） */
  function isWinning(candidate) {
    return typeof candidate.score === 'number' && candidate.score >= WIN_BASE;
  }

  /** 候选是否是"已被证明必败"的落子（不该再走下去） */
  function isLost(candidate) {
    return typeof candidate.score === 'number' && candidate.score <= -WIN_BASE;
  }

  /**
   * 按 softmax 权重在候选落子间采样。
   *
   *   w_i = exp(-(best - s_i) / temperature)
   *
   * temperature 越大越容易选中次优落子（越弱）；temperature <= 0 或只有一个
   * 候选时退化为取最优（同分随机打破平局）。
   */
  function pickByTemperature(candidates, temperature) {
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    var best = -Infinity;
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i].score > best) best = candidates[i].score;
    }

    var sameBest = [];
    for (var j = 0; j < candidates.length; j++) {
      if (candidates[j].score === best) sameBest.push(candidates[j]);
    }

    if (!(temperature > 0)) {
      return sameBest[Math.floor(Math.random() * sameBest.length)];
    }

    var total = 0;
    var weights = new Array(candidates.length);
    for (var k = 0; k < candidates.length; k++) {
      var w = Math.exp(-(best - candidates[k].score) / temperature);
      // 分差过大时 exp 会下溢成 0，给一个极小下限，
      // 保证理论上任何候选都有机会被选中（更像人，而不是像机器）
      if (!(w > 0)) w = 1e-9;
      weights[k] = w;
      total += w;
    }

    var roll = Math.random() * total;
    for (var m = 0; m < candidates.length; m++) {
      roll -= weights[m];
      if (roll <= 0) return candidates[m];
    }
    return candidates[candidates.length - 1];
  }

  /**
   * 从引擎给出的候选落子里，按档位挑一步。
   *
   * @param {Array<{move:number, score:number}>} candidates
   *        根节点各候选（引擎视角：分高 = 对当前行棋方好）
   * @param {number|Object} levelOrDef 档位号或档位定义对象
   * @returns {{move:number, score:number, suboptimal:boolean}|null}
   *          suboptimal=true 表示这一步不是引擎首选，UI 必须如实标注"次优"
   */
  function pickMove(candidates, levelOrDef) {
    if (!candidates || candidates.length === 0) return null;
    var def = resolveDef(levelOrDef);

    var tagged = candidates.slice().sort(function (a, b) { return b.score - a.score; });
    var top = tagged[0];

    // 已经找到强制获胜的落子：永远走它。
    // 否则低档位会"看到杀不走"，那不叫菜，那叫坏了。
    if (isWinning(top)) return tag(top, top);

    // 唯一候选 / 不需要采样
    if (tagged.length === 1 || def.temperature <= 0 && def.blunder <= 0) return tag(top, top);

    // 先剔除已必败与分差过大的候选
    var cap = LOSS_CAP[def.level] || 30000;
    var pool = [];
    for (var i = 0; i < tagged.length; i++) {
      if (isLost(tagged[i])) continue;
      if (top.score - tagged[i].score > cap) continue;
      pool.push(tagged[i]);
    }
    if (pool.length <= 1) return tag(top, top);

    // 失误模式：在更宽的候选池里均匀随机取一个
    if (def.blunder > 0 && Math.random() < def.blunder) {
      var wide = [];
      for (var j = 0; j < tagged.length; j++) {
        if (isLost(tagged[j])) continue;
        if (top.score - tagged[j].score > BLUNDER_CAP) continue;
        wide.push(tagged[j]);
      }
      if (wide.length > 1) {
        return tag(top, wide[Math.floor(Math.random() * wide.length)]);
      }
    }

    return tag(top, pickByTemperature(pool, def.temperature));
  }

  /** 把 pickMove 选中的候选打上"是否次优"标记 */
  function tag(top, chosen) {
    return {
      move: chosen.move,
      score: chosen.score,
      suboptimal: chosen !== top
    };
  }

  var Difficulty = {
    ENGINE: ENGINE,
    LEVELS: LEVELS,
    DEFAULT_LEVEL: DEFAULT_LEVEL,
    LOSS_CAP: LOSS_CAP,
    BLUNDER_CAP: BLUNDER_CAP,
    WIN_BASE: WIN_BASE,
    resolveDef: resolveDef,
    getLevel: getLevel,
    isWinning: isWinning,
    isLost: isLost,
    pickByTemperature: pickByTemperature,
    pickMove: pickMove
  };

  global.Difficulty = Difficulty;

  // 便于 Node 里驱动做难度校准
  if (typeof module !== 'undefined' && module.exports) module.exports = Difficulty;

})(globalThis);
