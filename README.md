# Gomoku · 五子棋（自研引擎）

纯前端 Web 五子棋对弈应用：**完全自研的迭代加深 α-β + VCF 算杀引擎**跑在
Web Worker 里，零第三方依赖、零构建、零下载，可直接托管在 GitHub Pages。

> 中文说明见 [README_CN.md](README_CN.md)。
> **在线试玩：<https://justa-cai.github.io/gomoku/>** · 源码：<https://github.com/justa-cai/gomoku>

## Highlights

- **Self-written engine** — iterative-deepening Negamax with alpha-beta pruning,
  Zobrist transposition table, killer/history heuristics and a **VCF**
  (victory-by-continuous-fours) threat-space search. No Stockfish, no
  third-party library, no WASM binary.
- **Zero dependencies** — no build step, no CDN, no image/font assets.
  Stones are drawn procedurally with Canvas radial gradients. The whole app
  is plain source files (< 100 KB).
- **Honest stats** — the side panel shows the real search depth / nodes / NPS /
  time / score of every move. Sub-optimal moves taken by low difficulty levels
  are explicitly marked *sub-optimal*; VCF kills are marked *VCF*.
- **Three modes** — vs AI (6 levels, play black or white), local 2-player,
  and AI-vs-AI for calibration and spectating.
- **Renju rules** — 15×15, Black forbids overlines, double-threes and
  double-fours; exact five wins for Black, five-or-more wins for White.
  Full board = draw.

## Difficulty

| Level | Name | Depth | Time cap | VCF | Sampling |
|:--:|:--:|:--:|:--:|:--:|:--|
| 1 | 入门 | 1 | 200 ms | off | temp 25000, blunder 30% |
| 2 | 初级 | 2 | 500 ms | off | temp 10000, blunder 12% |
| 3 | 中级 | 4 | 1 s | off | temp 3000 |
| 4 | 高级 | 6 | 1.5 s | on | — |
| 5 | 大师 | 8 | 2.5 s | on | — |
| 6 | 宗师 | 12 | 4 s | on | — |

At every level two hard rules bypass all weakening: if the engine can complete
five in one move it does; if the opponent threatens five it must block.
A losing-cap keeps sampled moves from looking broken instead of weak.

## Architecture

```text
UI (Canvas board / panels / menus, ES modules)
        │
Referee layer (rules.js: legality, five-in-a-row, draw, undo)
Difficulty layer (difficulty.js: single source of truth for levels & sampling)
        │
Engine bridge (bridge.js: seq-matched async facade, stale-reply dropping)
        │
engine.worker.js (Web Worker: iterative deepening α-β + TT + killers + VCF)
```

Scores are pattern-table based (FIVE 10M / open-four 1M / four 100k /
open-three 90k / …) computed with a sliding 5-cell window model that handles
jump shapes (X_XXX) naturally; the "distinct completion points" rule
distinguishes open fours from simple fours. Leaf evaluation is O(1) via
incrementally maintained per-line pattern sums.

## Run locally

```bash
python3 server.py          # → http://127.0.0.1:6326/
```

(Any static file server works. Opening `index.html` via `file://` won't —
Web Workers require HTTP.)

## Docker

```bash
docker build -t gomoku:latest .
docker run -d --name gomoku -p 8080:80 --restart unless-stopped gomoku:latest
```

Open <http://127.0.0.1:8080/>. The image uses Nginx for static files; no Node,
Python, or build step is required.

## Deploy

Push to a GitHub Pages repo; `.nojekyll` is included. No headers, no
cross-origin isolation, no build pipeline needed.

## License

MIT — see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md). All code in this
repository is original; algorithm background references are listed in
NOTICE.md.
