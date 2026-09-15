# NOTICE

## 自研声明

本项目的全部源码（引擎、规则、UI、样式、文档）均为原创，**不包含任何
第三方版权代码**。因此整体许可为 MIT（见 `LICENSE`），无 copyleft 传染——
这是本棋类系列（02.chess / 03.chess_master 均因引擎 GPL 而 GPL）中
唯一可以自由商用的一个。

- 无第三方 JS 库（无 chess.js / chessground 等价物）
- 无图片、字体、SVG 资源（棋子为 Canvas 径向渐变程序化绘制）
- 无构建产物（无 wasm / 打包器输出）

## 算法背景（公开文献与公认技术，非代码引用）

实现参考的是公开的经典算法，均为学界/工程界常识而非特定代码的移植：

| 技术 | 背景出处 |
|---|---|
| Minimax / Negamax α-β 剪枝 | Knuth & Moore (1975), *An Analysis of Alpha-Beta Pruning* |
| 迭代加深、置换表、杀手/历史启发 | Schaeffer (1983 的一系列棋类搜索综述)；AIMA 第 5 章 |
| Zobrist 哈希 | Zobrist (1970), *A New Hashing Method with Application for Game Playing* |
| 威胁空间搜索 / VCF-VCT 算杀 | Allis (1994), *Searching for Solutions in Games and Artificial Intelligence*（五子棋先手必胜证明，Victoria 程序） |
| 棋型评估表（活四/冲四/活三…） | Gomocup 竞赛引擎的通行做法，如 Carbon (Czardybon, 2002) 的公开文档 |

## 运行环境

- 现代浏览器（需支持 ES2020 模块、Web Worker、Canvas、ResizeObserver）
- 本地开发：`python3 server.py`（默认端口 6326）
- 部署：任意静态托管（GitHub Pages 直接推 master 即可，`.nojekyll` 已就位）
