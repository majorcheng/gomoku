# 项目目录结构说明 (Project Tree Specification)

## 1. 完整目录树

```text
04.Gomoku/
├── Dockerfile                  # Nginx 静态部署镜像
├── .dockerignore               # Docker 构建上下文忽略项
├── index.html                  # 页面主入口（HTML5 语义化）
├── js/
│   ├── app.js                  # 主控：装配棋盘、裁判、引擎；轮次/终局/悔棋/重开
│   ├── difficulty.js           # ★ 难度单一事实来源（六档定义 + 落子采样）
│   ├── rules.js                # 裁判层：棋盘状态、禁手/落子合法性、五连/满盘判定
│   ├── engines/
│   │   ├── bridge.js           # 引擎门面：Worker 生命周期 + seq 配对 + info 转发
│   │   └── engine.worker.js    # ★ 自研引擎 Worker：迭代加深 α-β + 置换表 + VCF
│   └── ui/
│       ├── board.js            # Canvas 棋盘：渲染、悬停预览、点击、胜利连线
│       ├── panel.js            # 侧边栏：对局信息、搜索数据表格、实时状态
│       └── menu.js             # 多级菜单遮罩与对局总结浮层
├── styles/
│   ├── tokens.css              # 设计变量（颜色/尺寸/动画）
│   ├── base.css                # 重置与排版
│   ├── components/
│   │   ├── layout.css          # 整体 Grid/Flex 与响应式
│   │   ├── board.css           # 棋盘外壳、评估条
│   │   ├── panel.css           # 侧边栏与搜索数据表格
│   │   ├── controls.css        # 按钮组、计分徽章
│   │   └── modal.css           # 菜单遮罩、总结浮层、toast
│   └── main.css                # 统一 @import 入口
├── specs/                      # 项目规格与需求文档 (SDD)
│   ├── prd.md                  # 产品需求文档
│   ├── ui.md                   # UI 界面与交互设计规范
│   └── project_tree.md         # 本文件
├── server.py                   # 本地静态开发服务器
├── scripts/check.mjs           # Node 标准库回归与可选基准对照
├── scripts/match.mjs           # 同规则同预算、固定开局换先对弈
├── .nojekyll                   # GitHub Pages：禁用 Jekyll
├── LICENSE                     # MIT 全文（全自研，无第三方代码）
├── NOTICE.md                   # 自研声明与算法文献出处
├── README.md                   # 英文说明
└── README_CN.md                # 中文说明
```

与 02/03 相比**没有**的目录及其原因：

| 目录 | 02/03 的情况 | 本项目 | 原因 |
|---|---|---|---|
| `js/vendor/` | chess.js / chessground 等第三方产物 | **无** | 零第三方依赖，规则与棋盘全部自研 |
| `js/engines/stockfish/` | 7 MB 引擎产物 | **无** | 引擎是自研 JS，就是 `engine.worker.js` |
| `data/` | ECO 开局库等 | **无** | 当前直接使用默认中央开局点 |
| `third-party/` | 源码级第三方资料 | **无** | 无第三方 |
| `test/` | — | **无** | 聚焦回归统一运行 `node scripts/check.mjs`，无测试框架 |

---

## 2. 核心模块与职责分工

### 2.1 视图层 (`js/ui/`)

* **`board.js`**：只管 Canvas。对外暴露
  `createBoard(container, callbacks)` → `{ setPosition(moves), markLast(index),
  showWin(line), setInteractive(bool), redraw() }`。**不含任何规则判断**——
  落子合法性由 `app.js` 问 `rules.js` 后决定是否采纳点击。
* **`panel.js`**：侧栏渲染（对局信息、走子/搜索统计表、实时迭代状态、
  引擎参数卡）。纯函数式渲染，无内部对局状态。
* **`menu.js`**：多级菜单遮罩与对局总结浮层，档位按钮从 `difficulty.js`
  生成。

### 2.2 裁判层 (`js/rules.js`)

主线程的规则权威，ES 模块：

* `createGame()` → `{ board, moves, turn, over, winner, winLine }`；
* `place(game, index)` → 落子并返回 `{ legal, win, winLine, full, forbidden, reason }`；
* `forbiddenReason(board, index, color)` → 判断黑方长连、双三、双四禁手；
* `undo(game, n)` → 撤回 n 步（悔棋）；
* `coordName(index)` / `indexFromCoord(name)` → `H8` 风格坐标互转；
* `checkFive(board, index)` → 从刚落的子出发向 4 个方向数连子，
  返回获胜线（黑方恰五、白方含长连）或 `null`。

### 2.3 难度层 (`js/difficulty.js`)

六档参数与采样算法的**唯一出处**，经典脚本暴露全局 `Difficulty`
（主线程用 script，module Worker 用 import）。

* 档位定义见 [prd.md](prd.md) §5；
* 采样入口 `pickMove(candidates, level)`：带损失上限，候选必败或分差
  超阈值时强制回引擎首选。

### 2.4 引擎层 (`js/engines/engine.worker.js` + `bridge.js`)

* `engine.worker.js`：自研模块 Worker，导入共享裁判，采用消息协议（`search` / `info` /
  `result`），不依赖 DOM，同时默认导出 Node 验证入口。
* `bridge.js`：主线程门面，`load()` / `search(moves, level)` /
  `cancel()` / `unload()`，内部维护 `seq` 配对，丢弃过期应答，
  并把 `info` 流回调给侧栏。

> **硬约束**：引擎与 UI 之间只传**消息**——Worker 不读 DOM，
> 主线程不碰搜索内部状态。这保证引擎可以脱离浏览器在 Node 里
> 直接驱动（难度校准脚本就是这么跑的）。

---

## 3. 与 02.chess / 03.chess_master 的结构差异

| 项 | 02.chess | 03.chess_master | 本项目 | 原因 |
|---|---|---|---|---|
| 引擎来源 | Pikafish WASM（外部） | Stockfish 18 WASM（外部） | **自研 JS** | 五子棋无官方强引擎 WASM 构建 |
| 引擎体积 | 5 MB + 49 MB 权重 | 7.0 MB | **~40 KB** | 纯 JS 源码即产物 |
| 跨源隔离 | 需要 COOP/COEP | 不需要 | **不需要** | 普通 Worker |
| 规则裁判 | chess.js（第三方） | chess.js（第三方） | **自研 rules.js** | 五子棋规则简单，无现成库必要 |
| 棋盘渲染 | 自绘 DOM | chessground（第三方） | **自研 Canvas** | 15×15 网格沿用 Canvas |
| 难度实现 | Worker 内采样 | 主线程 difficulty.js | 主线程 difficulty.js | 引擎自研，原生支持档位参数 |
| 许可 | GPL-3.0（传染） | GPL-3.0（传染） | **MIT** | 零第三方代码 |
