// 同预算成对对弈：node scripts/match.mjs /path/to/baseline.worker.js /path/to/results.json
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as rules from '../js/rules.js';

const currentUrl = new URL('../js/engines/engine.worker.js', import.meta.url);
const central = [[15,15],[16,16],[14,16],[16,14],[14,14],[13,15],[17,15],
  [15,17],[15,13],[13,13],[17,17],[13,17],[17,13],[18,14]];
const spread = [[4,4],[5,5],[24,24],[25,25],[4,24],[5,23],[24,4],
  [23,5],[14,14],[15,15],[13,16],[16,13],[6,6],[23,23]];
const openings = [
  ...[4,8,12,14].map(n => ({ name: 'central_' + n, coordinates: central.slice(0,n) })),
  ...[4,8,12,14].map(n => ({ name: 'spread_' + n, coordinates: spread.slice(0,n) })),
  { name: 'corner_nw', coordinates: central.map(([r,c]) => [r-13,c-13]) },
  { name: 'corner_se', coordinates: central.map(([r,c]) => [r+11,c+11]) },
  { name: 'asymmetric_a', coordinates: [[15,15],[15,16],[14,15],[16,15],[13,16],[14,16]] },
  { name: 'asymmetric_b', coordinates: [[15,15],[14,14],[16,14],[14,16],[17,15],[15,14]] }
];

function seed(coordinates) {
  const game = rules.createGame();
  for (const [r,c] of coordinates) {
    const placed = rules.place(game, r * rules.SIZE + c);
    if (!placed.legal || game.over) throw new Error('invalid opening');
  }
  return game;
}

if (isMainThread) {
  const baseline = pathToFileURL(resolve(process.argv[2])).href;
  const output = resolve(process.argv[3]);
  const hash = url => createHash('sha256').update(readFileSync(new URL(url))).digest('hex');
  const report = { date: new Date().toISOString(), node: process.version, size: rules.SIZE,
    level: 6, moveBudgetMs: 4000, extraMoveLimit: 80, concurrency: 4,
    currentSha256: hash(currentUrl), baselineSha256: hash(baseline), baseline, games: [] };
  const jobs = openings.flatMap(opening => {
    seed(opening.coordinates);
    return [rules.BLACK, rules.WHITE].map(color => ({ ...opening, color, baseline }));
  });
  let next = 0;
  await Promise.all(Array.from({ length: report.concurrency }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const worker = new Worker(new URL(import.meta.url), { workerData: job });
      const exited = once(worker, 'exit');
      const [result] = await once(worker, 'message');
      await exited;
      report.games.push(result);
      writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ completed: report.games.length, opening: result.name,
        currentColor: result.color, winner: result.winner, end: result.end, moves: result.turns.length }));
    }
  }));
  const summary = { currentWins: 0, baselineWins: 0, draws: 0, unfinished: 0, errors: 0 };
  for (const game of report.games) {
    if (game.end === 'error') summary.errors++;
    else if (game.end === 'limit') summary.unfinished++;
    else if (!game.winner) summary.draws++;
    else if (game.winner === game.color) summary.currentWins++;
    else summary.baselineWins++;
  }
  report.summary = summary;
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(summary));
} else {
  const { default: current } = await import(currentUrl);
  const { default: baseline } = await import(workerData.baseline);
  const game = seed(workerData.coordinates);
  const result = { name: workerData.name, color: workerData.color, opening: game.moves.slice(),
    winner: null, end: 'limit', turns: [] };
  for (let turn = 0; turn < 80 && !game.over; turn++) {
    const side = rules.turnOf(game);
    try {
      const response = (side === workerData.color ? current : baseline).search(game.moves.slice(), 6);
      const candidate = response.candidates[0];
      if (!candidate || !Number.isFinite(candidate.score)) throw new Error('invalid result');
      const placed = rules.place(game, candidate.move);
      if (!placed.legal) throw new Error('illegal move ' + rules.coordName(candidate.move));
      result.turns.push({ side, move: candidate.move, depth: response.depth, timeMs: response.timeMs,
        nodes: response.nodes, tacticalNodes: response.tacticalNodes || 0, vcf: response.vcf,
        stopReason: response.stopReason });
      if (game.over) { result.end = 'finished'; result.winner = game.winner; }
    } catch (error) {
      result.end = 'error'; result.error = String(error); break;
    }
  }
  parentPort.postMessage(result);
}
