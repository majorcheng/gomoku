# Gomoku · 五子棋（自研引擎）

纯前端 Web 五子棋对弈应用：**完全自研的迭代加深 α-β + VCF 算杀引擎**跑在
Web Worker 里，零第三方依赖、零构建、零下载，可直接托管在 GitHub Pages。

> English readme: [README.md](README.md)。
> **在线试玩：<https://justa-cai.github.io/gomoku/>** · 源码：<https://github.com/justa-cai/gomoku>

## 核心特性

- **自研引擎**：迭代加深 Negamax α-β + Zobrist 置换表 + 杀手/历史启发 +
  **VCF 连续冲四算杀**。没有 Stockfish、没有第三方库、没有 WASM 产物。
- **零依赖**：无构建步骤、无 CDN、无图片字体资源（棋子是 Canvas 径向渐变
  程序画的），整个应用就是源码本身（< 100 KB）。
- **数据诚实**：侧栏如实展示每一手真实的搜索深度/节点/NPS/耗时/分数；
  低难度走了非首选落子会明确标注「次优」，算杀标注「VCF」。
- **三种模式**：人机（六档难度、可执黑执白）、本机双人、机机对战
  （难度校准与观赏用）。
- **规则**：15×15 连珠规则，黑方禁长连、双三、双四；黑方恰好五连或白方五连（含长连）者胜，落满 225 点和棋。

## 难度设计

| 档 | 名称 | 深度 | 时限 | VCF | 采样 |
|:--:|:--:|:--:|:--:|:--:|:--|
| 1 | 入门 | 1 | 200 ms | 关 | 温度 25000，失误率 30% |
| 2 | 初级 | 2 | 500 ms | 关 | 温度 10000，失误率 12% |
| 3 | 中级 | 4 | 1 s | 关 | 温度 3000 |
| 4 | 高级 | 6 | 1.5 s | 开 | — |
| 5 | 大师 | 8 | 2.5 s | 开 | — |
| 6 | 宗师 | 12 | 4 s | 开 | — |

所有档位保留两条不可弱化的硬底线：己方能一步成五必走、对方一步成五必挡。
采样带损失上限，低档位"走得弱"但不会"走得像坏了"。

档位参数的单一事实来源是 `js/difficulty.js`（主线程与引擎 Worker 读同一份）。

## 架构

```text
视图层（Canvas 棋盘 / 侧栏 / 菜单，ES 模块）
        │
裁判层 rules.js（落子合法性、禁手/五连判定、满盘和棋、悔棋）
难度层 difficulty.js（六档参数 + 采样的唯一出处）
        │
引擎门面 bridge.js（seq 配对的异步门面，过期应答静默丢弃）
        │
engine.worker.js（Web Worker：迭代加深 α-β + 置换表 + 杀手启发 + VCF）
```

评估用棋型表（五连 10M / 活四 1M / 冲四 100k / 活三 90k / …），以 5 格滑动
窗口统计——天然覆盖跳棋型（X_XXX），并用"成五完成点是否互不相同"区分活四与
冲四。叶子评估 O(1)：每落/撤一子只重算经过该点的 4 条线，全局黑白分增量维护。

## 本地运行

```bash
python3 server.py          # → http://127.0.0.1:6326/
```

（任何静态服务器都行；`file://` 直接打开不行——Web Worker 需要 HTTP。）

## Docker 部署

```bash
docker build -t gomoku:latest .
docker run -d --name gomoku -p 8080:80 --restart unless-stopped gomoku:latest
```

浏览器访问 `http://127.0.0.1:8080/`。镜像使用 Nginx 提供静态文件，不需要 Node、Python 或构建步骤。

## 部署

推到 GitHub Pages 仓库即可，`.nojekyll` 已就位。不需要任何响应头、
跨源隔离或构建管线。

## 调研记录（为什么这样做）

立项前做过一轮技术调研，结论浓缩如下：

1. **五子棋没有官方强引擎的 WASM 构建**（不像国际象棋有 Stockfish.js），
   Gomocup 级 C++ 引擎要自己用 Emscripten 交叉编译，维护成本高于自研；
2. **Alpha-Beta + 启发式 + VCF 的组合棋力足够**——研究与实践（如
   lihongxun945/gobang ~1.8k star 的纯 JS 实现）表明 6-8 层有效深度已远超
   休闲玩家；本引擎实测 L4（6 层 + VCF）对 L1 双色全胜；
3. **AlphaZero 路线训练成本高**（8×8 棋盘需自对弈 2000-3000 局），
   且与"纯静态、即开即玩"的部署目标冲突，故不采用。

详细调研过程（算法对比、开源项目星数核实）见 `specs/prd.md` 的引用文献。

## 与系列前作的结构差异

| 项 | 02.chess | 03.chess_master | 本项目 |
|---|---|---|---|
| 引擎 | Pikafish WASM（外部，GPL） | Stockfish 18 WASM（外部，GPL） | **自研 JS（MIT）** |
| 引擎体积 | 5 MB + 49 MB 权重 | 7.0 MB | **~50 KB 源码** |
| 规则裁判 | chess.js（第三方） | chess.js（第三方） | **自研 rules.js** |
| 棋盘渲染 | 自绘 DOM | chessground（第三方） | **自研 Canvas** |
| 跨源隔离 | 需要 COOP/COEP | 不需要 | 不需要 |
| 许可 | GPL-3.0 | GPL-3.0 | **MIT** |

## 许可

MIT —— 见 [LICENSE](LICENSE)。全部代码原创；算法背景文献见 [NOTICE.md](NOTICE.md)。
