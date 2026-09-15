// 无依赖回归：node scripts/check.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import * as rules from '../js/rules.js';
import liveEngine from '../js/engines/engine.worker.js';

const workerSource = readFileSync(new URL('../js/engines/engine.worker.js', import.meta.url), 'utf8');
const difficultySource = readFileSync(new URL('../js/difficulty.js', import.meta.url), 'utf8');
const cell = (row, col) => row * rules.SIZE + col;
const movesOf = (coords) => coords.map(([r, c]) => cell(r, c));
const plain = (value) => JSON.parse(JSON.stringify(value));

function engineWith(def, now = () => performance.now(), source = workerSource) {
  const context = vm.createContext({ ...rules, winningLine: rules.checkFive, performance: { now },
    auditMove(board, p, side) {
      assert.equal(board[p], rules.EMPTY);
      assert.equal(rules.forbiddenReason(board, p, side), null, `搜索中不得落禁手 ${rules.coordName(p)}`);
    }
  });
  vm.runInContext(difficultySource, context);
  // 只在测试 VM 内观察搜索状态，不向生产接口增加测试专用能力。
  vm.runInContext(source.replace(/^import .*;$/gm, '').replace('export default engine;', 'globalThis.__GomokuEngine = engine;')
    .replace('board[idx] = color;', 'if (auditing) { auditMove(board, idx, color); audited++; } board[idx] = color;')
    .replace('return searchRoot(global.Difficulty.getLevel(level), onDepth, t0);',
      'try { auditing = true; return searchRoot(global.Difficulty.getLevel(level), onDepth, t0); } finally { auditing = false; }')
    .replace('var api = {', `var auditing = false, audited = 0; var api = {
    state: () => ({ moves: moveStack.slice(), board: Array.from(board), sumB, sumW, hash1, hash2 }),
    work: () => ({ nodes, vcfNodes }),
    audited: () => audited,
    fullEval: () => [BLACK, WHITE].map(color => LINES.flat().reduce((sum, line) => sum + scoreLine(line, color), 0)),
    lineEval: (moves, row, color) => { resetBoard(moves); return scoreLine(LINES[0][row], color); },
    leaf: moves => { resetBoard(moves); deadline = Infinity; nodes = 0; useTactics = true; tacticalLimit = TACTICAL_PLIES;
      try { auditing = true; return negamax(0, -INF, INF, 0); } finally { auditing = false; } },
    points: () => Array.from(board, (v, p) => v ? null : [scorePoint(p, BLACK), scorePoint(p, WHITE)]),
  `), context);
  if (def) context.Difficulty.getLevel = () => def;
  return context.__GomokuEngine;
}

const definition = { depth: 4, timeMs: 60000, candWidth: 20, vcf: false };
const central = movesOf([[7,7],[8,8],[6,8],[8,6],[6,6],[5,7],[9,7],
  [7,9],[7,5],[5,5],[9,9],[5,9],[9,5],[10,6]]);
const spread = movesOf([[2,2],[3,3],[11,11],[12,12],[2,11],[3,10],[11,2],
  [10,3],[6,6],[7,7],[5,8],[8,5],[4,4],[10,10]]);

const engine = engineWith(definition);
assert.equal(rules.SIZE, 15);
assert.equal(rules.AREA, 225);
assert.equal(globalThis.Difficulty.getLevel(6).timeMs, 5000);
assert.equal(engine.SIZE, rules.SIZE);
assert.equal(engine.CENTER, rules.CENTER);
assert.equal(rules.coordName(rules.CENTER), 'H8');
for (let i = 0; i < rules.AREA; i++) assert.equal(rules.indexFromCoord(rules.coordName(i)), i);
for (const invalid of ['A0', 'A16', 'P1', 'P15', 'AA1', 'O16', 'A01', 'AD300', 'a1', '', null]) {
  assert.equal(rules.indexFromCoord(invalid), -1);
}
assert.equal(rules.coordName(0), 'A15');
assert.equal(rules.coordName(224), 'O1');
assert.equal(engine.search([], 3).candidates[0].move, rules.CENTER);
assert.equal(liveEngine.search([], 6).candidates[0].move, rules.CENTER, '真实 ES module 入口可加载与搜索');
assert.equal(engine.genCandidateCount([rules.CENTER]), 24);
assert.equal(engine.genCandidateCount([0]), 8);

// 棋盘边缘的落子、胜利和悔棋；禁手依旧由裁判决定。
const game = rules.createGame();
for (const move of movesOf([[14,10],[0,0],[14,11],[0,2],[14,12],[0,4],[14,13],[0,6]])) {
  assert.equal(rules.place(game, move).legal, true);
}
assert.equal(rules.place(game, cell(14,14)).win, true);
assert.equal(game.winner, rules.BLACK);
assert.equal(rules.undo(game, 2), 2);
assert.equal(game.over, false);
assert.equal(game.board[cell(14,14)], rules.EMPTY);

// 无五连的近满盘，最后一手黑棋填满第 225 点。
const draw = rules.createGame();
const colors = [[], []];
for (let r = 0; r < rules.SIZE; r++) for (let c = 0; c < rules.SIZE; c++) {
  const color = (r + Math.floor(c / 2)) % 2 + 1;
  draw.board[cell(r,c)] = color;
  colors[color - 1].push(cell(r,c));
}
const lastBlack = colors[0].pop();
draw.board[lastBlack] = rules.EMPTY;
colors[1].forEach((p, i) => draw.moves.push(colors[0][i], p));
assert.equal(rules.place(draw, lastBlack).full, true);
assert.equal(draw.moves.length, 225);
assert.equal(draw.winner, 0);
assert.equal(engine.search(draw.moves, 3).candidates.length, 0);

for (const [coords, expected] of [
  [[[7,2],[7,3],[7,4],[7,6],[7,7]], rules.FORBIDDEN.OVERLINE],
  [[[7,6],[7,8],[6,7],[8,7]], rules.FORBIDDEN.DOUBLE_THREE],
  [[[7,4],[7,5],[7,6],[4,7],[5,7],[6,7]], rules.FORBIDDEN.DOUBLE_FOUR],
  [[[7,4],[7,5],[7,6]], null]
]) {
  const board = new Int8Array(rules.AREA);
  for (const p of movesOf(coords)) board[p] = rules.BLACK;
  const at = expected === rules.FORBIDDEN.OVERLINE ? cell(7,5) : cell(7,7);
  const before = board.slice();
  assert.equal(rules.forbiddenReason(board, at), expected);
  assert.deepEqual(board, before);
  assert.equal(rules.forbiddenReason(board, at, rules.WHITE), null);
}

// 跳活三只需一个合法延伸；其延伸若是禁手，则属于假活三。
const jumped = [[7,6],[7,9],[6,7],[9,7]];
for (const [name, additions, expected] of [
  ['交叉跳活三', [], rules.FORBIDDEN.DOUBLE_THREE],
  ['长连使一个三无效', [[4,8],[5,8],[6,8],[8,8],[9,8]], null],
  ['双四使一个三无效', [[5,8],[6,8],[8,8]], null],
  ['递归双三使一个三无效', [[8,9],[6,9],[5,10]], null]
]) {
  const board = new Int8Array(rules.AREA);
  for (const p of movesOf([...jumped, ...additions])) board[p] = rules.BLACK;
  const before = board.slice();
  assert.equal(rules.forbiddenReason(board, cell(7,7)), expected, name);
  assert.deepEqual(board, before, name + ' 不污染棋盘');
}
const exact = new Int8Array(rules.AREA);
for (const p of movesOf([[7,2],[7,3],[7,4],[7,6],[7,7],[3,5],[4,5],[5,5],[6,5]])) exact[p] = rules.BLACK;
assert.equal(rules.forbiddenReason(exact, cell(7,5)), null, '恰五优先于另一方向长连');
exact[cell(7,5)] = rules.BLACK;
assert.equal(rules.checkFive(exact, cell(7,5)).length, 5);
const longWhite = new Int8Array(rules.AREA);
for (let c = 9; c < 15; c++) longWhite[cell(14,c)] = rules.WHITE;
assert.equal(rules.checkFive(longWhite, cell(14,14)).length, 6);
const separateThrees = movesOf([[7,1],[7,0],[7,2],[7,6],[7,3],[7,7],
  [7,8],[7,13],[7,9],[0,0],[7,10],[0,2]]);
assert.equal(engine.lineEval(separateThrees, 7, rules.BLACK), 6000, '隔开的两个眠三分别计分');

const forbiddenWin = 'C8 O15 D8 O13 E8 O11 G8 O9 H8 O7'.split(' ').map(rules.indexFromCoord);
const forbiddenGame = rules.createGame();
for (const p of forbiddenWin) assert.equal(rules.place(forbiddenGame, p).legal, true);
const corrected = engine.search(forbiddenWin, 6);
assert.equal(corrected.forced, 'none');
assert.ok(corrected.candidates.length > 1);
assert.ok(corrected.candidates.every(c => c.move !== rules.indexFromCoord('F8') &&
  rules.forbiddenReason(forbiddenGame.board, c.move) === null));
assert.notEqual(corrected.candidates[0].move, 0, '不再自动改下 A15');
const whiteToMove = engine.search([...forbiddenWin, rules.indexFromCoord('I13')], 6);
assert.equal(whiteToMove.forced, 'none', '白方不必防守黑方非法成五点');
const forbiddenBlock = 'C8 F12 D8 F11 E8 F10 G8 F9 H8 O15 F13 O13'.split(' ').map(rules.indexFromCoord);
const lost = engine.search(forbiddenBlock, 6);
assert.ok(lost.candidates[0].score <= -9000000, '唯一挡点是禁手时，不能把非法防守当作脱险');
assert.ok(lost.candidates.every(c => c.move !== rules.indexFromCoord('F8')));

const win = movesOf([[13,9],[0,0],[13,10],[0,2],[13,11],[0,4],[13,12],[0,6]]);
const block = movesOf([[12,9],[12,10],[0,0],[12,11],[0,2],[12,12],[0,4],[12,13]]);
assert.equal(engine.search(win, 3).forced, 'win1');
const blocked = engine.search(block, 3);
assert.equal(blocked.forced, 'block1');
assert.equal(blocked.candidates[0].move, cell(12,14));

// 第二个挡点超时时，不能用它的静态分覆盖第一个挡点的完整搜索分。
const doubleThreat = movesOf([[0,0],[12,10],[0,2],[12,11],[0,4],[12,12],[0,6],[12,13]]);
let reads = 0;
const partialBlock = engineWith({ ...definition, timeMs: 5 }, () => reads++ >= 2 ? 5 : 0);
const partial = partialBlock.search(doubleThreat, 3);
assert.equal(partial.depth, 2);
assert.deepEqual(plain(partial.candidates), plain(engine.search(doubleThreat, 3).candidates));
assert.deepEqual(plain(partialBlock.state().moves), doubleThreat);

for (const moves of [central, spread]) {
  engine.evalBoard(moves);
  const expected = plain(engine.state());
  const points = plain(engine.points());
  const result = engine.search(moves, 3);
  assert.equal(result.depth, 4);
  assert.ok(result.candidates.every(c => !moves.includes(c.move) && Number.isFinite(c.score)));
  assert.deepEqual(plain(engine.state()), expected, '搜索后恢复棋盘、评估和哈希');
  assert.deepEqual(plain(engine.points()), points, '落子/撤子后点评分缓存与重算一致');
  assert.deepEqual(plain(engine.fullEval()), [expected.sumB, expected.sumW], '增量线分与全盘重算一致');
}
assert.ok(engine.audited() > 0, '普通搜索与 VCF 落子审计必须生效');

// 单调虚拟时钟在递归落两手后耗尽预算，精确覆盖普通搜索/挡点/VCF 的退出恢复。
const threat = movesOf([[7,6],[7,5],[7,7],[2,3],[7,8],[2,5]]);
for (const [moves, vcf] of [[central, false], [block, false], [threat, true]]) {
  let timed, expired = false;
  timed = engineWith({ ...definition, candWidth: 32, timeMs: 5, vcf }, () => {
    if (timed && (!vcf || timed.work().vcfNodes > 0) && timed.state().moves.length >= moves.length + 2) expired = true;
    return expired ? 5 : 0;
  });
  timed.evalBoard(moves);
  const before = plain(timed.state());
  const points = plain(timed.points());
  let lastInfo;
  const result = timed.search(moves, 3, info => { lastInfo = info; });
  assert.ok(expired, `必须触发递归超时: forced=${result.forced}, vcf=${vcf}, nodes=${result.nodes}`);
  assert.deepEqual(plain(timed.state()), before);
  assert.deepEqual(plain(timed.points()), points);
  assert.deepEqual(plain(timed.fullEval()), [before.sumB, before.sumW]);
  assert.ok(result.candidates.every(c => Number.isFinite(c.score)));
  assert.equal(result.vcf, false);
  if (lastInfo) {
    assert.equal(result.depth, lastInfo.depth);
    assert.equal(result.candidates[0].score, lastInfo.score);
  }
}
const killer = engineWith({ ...definition, vcf: true });
const kill = killer.search(movesOf([[7,6],[0,0],[7,7],[1,0],[7,8],[2,1]]), 4);
assert.ok(kill.candidates[0].score >= 9000000, '短杀可由基础搜索直接证明');
assert.ok(kill.nodes > 0);
assert.ok(engine.leaf(win) >= 9000000, '叶子的一步赢必须识别为胜');
assert.ok(engine.leaf(doubleThreat) <= -9000000, '叶子的双端四必须识别为负');
assert.ok(Math.abs(engine.leaf(block)) < 9000000, '唯一可挡的冲四不能误判为必败');
assert.deepEqual(plain(engine.state().moves), block);
const narrow = engineWith({ ...definition, candWidth: 1, depth: 1, vcf: true });
const attacks = narrow.search(movesOf([[7,6],[0,0],[7,7],[1,0],[7,8],[2,1]]), 6);
assert.ok(attacks.candidates.length > 1, '真实冲四不受普通候选限额裁切');
assert.ok(attacks.candidates[0].score >= 9000000);

let split;
split = engineWith({ ...definition, timeMs: 4000, vcf: true }, () => split && split.work().vcfNodes > 0 ? 500 : 0);
const depths = [];
const splitResult = split.search(threat, 6, info => depths.push(info.depth));
assert.ok(splitResult.vcfNodes > 0);
assert.equal(splitResult.vcfStopReason, 'time-limit');
assert.deepEqual(depths, [1,2,3,4], 'VCF 子预算耗尽后继续普通搜索');
assert.equal(splitResult.depth, 4);
assert.deepEqual(plain(split.state().moves), threat);

let elapsed = 0;
const half = engineWith({ ...definition, timeMs: 100 }, () => elapsed);
const halfResult = half.search(central, 6, info => { if (info.depth === 2) elapsed = 60; });
assert.equal(halfResult.depth, 4, '超过一半预算后仍可完成后续层');

// Node 线程仅适配 Worker 消息 API；加载的是未改写的真实 ES module 与依赖。
const threaded = new Worker(`
  const { parentPort } = require('node:worker_threads');
  globalThis.postMessage = message => parentPort.postMessage(message);
  globalThis.addEventListener = (name, listener) => parentPort.on(name, data => listener({data}));
  import(${JSON.stringify(new URL('../js/engines/engine.worker.js', import.meta.url).href)});
`, { eval: true });
try {
  const [ready] = await once(threaded, 'message', { signal: AbortSignal.timeout(5000) });
  assert.equal(ready.type, 'ready');
  for (const [seq, moves, expected] of [[1, forbiddenWin, 'result'], [2, [0,0], 'error'], [3, [], 'result']]) {
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { threaded.off('message', listener); reject(new Error('Worker response timeout')); }, 5000);
      function listener(msg) {
        if (msg.seq !== seq || msg.type === 'info') return;
        clearTimeout(timer); threaded.off('message', listener); resolve(msg);
      }
      threaded.on('message', listener);
    });
    threaded.postMessage({ type: 'search', seq, moves, level: 1 });
    const message = await response;
    assert.equal(message.type, expected);
    if (expected === 'result') {
      assert.ok(Number.isFinite(message.timeMs));
      assert.notEqual(message.move, rules.indexFromCoord('F8'));
    }
  }
} finally {
  await threaded.terminate();
}

// Bridge 的测试替身仅验证加载失败、取消与过期应答的路由，不代表浏览器视觉验收。
class StubWorker {
  constructor(url, options) { this.listeners = {}; assert.equal(options.type, 'module'); StubWorker.latest = this; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  postMessage(message) { this.request = message; }
  terminate() {}
  emit(type, data) { this.listeners[type](type === 'message' ? {data} : data); }
}
const bridgeContext = vm.createContext({ Worker: StubWorker, console });
vm.runInContext(readFileSync(new URL('../js/engines/bridge.js', import.meta.url), 'utf8'), bridgeContext);
const bridge = bridgeContext.Bridge;
const failedLoad = bridge.load();
StubWorker.latest.emit('error', { message: 'module load failure' });
await assert.rejects(failedLoad, /module load failure/);
const loaded = bridge.load();
StubWorker.latest.emit('message', { type: 'ready' });
await loaded;
const cancelled = bridge.search([], 1);
const oldSeq = StubWorker.latest.request.seq;
bridge.cancel();
assert.equal(await cancelled, null);
const current = bridge.search([], 1);
const newSeq = StubWorker.latest.request.seq;
StubWorker.latest.emit('message', { type: 'result', seq: oldSeq, move: 0 });
assert.equal(bridge.status().busy, true);
StubWorker.latest.emit('message', { type: 'result', seq: newSeq, move: rules.CENTER });
assert.equal((await current).move, rules.CENTER);
bridge.unload();

console.log('PASS: 15×15 规则、宗师 5000ms、真假活三、恰五优先、搜索逐手合法性、叶子战术与分段评分、缓存与超时恢复、VCF 子预算、真实模块 Worker 协议、Bridge 路由');

// 可选真实宗师预算检查：node scripts/check.mjs --bench
if (process.argv.includes('--bench')) {
  for (const [name, moves] of Object.entries({ central, spread, forbiddenWin })) {
    const result = liveEngine.search(moves, 6);
    console.log(JSON.stringify({ name, depth: result.depth, timeMs: result.timeMs, nodes: result.nodes,
      vcfNodes: result.vcfNodes, stopReason: result.stopReason, best: result.candidates[0] }));
  }
}
