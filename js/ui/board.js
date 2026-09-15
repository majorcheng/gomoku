/**
 * board.js - Canvas 棋盘视图
 *
 * 只管"把局面画出来 + 把点击翻译成交叉点下标"，不含任何规则判断：
 * 落子是否合法由 app.js 问过 rules.js 之后决定要不要采纳。
 *
 * 渲染清单：
 *   - 木色盘面 + 15×15 网格 + 五个星位 + 坐标（列 A..O 底部，行 1..15 左侧）
 *   - 棋子：径向渐变程序化绘制（黑子左上高光 / 白子浅灰描边），无图片资源
 *   - 最后一手：棋子中心红点（颜色 + 形状双重编码）
 *   - 悬停预览：空点上的半透明棋子（仅人回合）
 *   - 胜利连线：获胜五连首尾连线 + 获胜棋子高亮描边
 *   - 落子动画：最后一手 120ms 缩放淡入（requestAnimationFrame 驱动）
 *
 * 高分屏：canvas 物理尺寸 = CSS 尺寸 × devicePixelRatio，ctx 统一缩放。
 *
 * @license MIT
 */

import { SIZE, EMPTY, BLACK } from '../rules.js';

const STAR_POINTS = [
  [3, 3], [11, 3], [3, 11], [11, 11], [7, 7]
];

/**
 * @param {HTMLCanvasElement} canvas 画布（铺满 .board-stage）
 * @param {{onPlace:function(number):void, canPlace:function(number):boolean}} handlers
 */
export function createBoard(canvas, handlers) {
  const ctx = canvas.getContext('2d');

  // ── 视图状态 ──
  let boardArr = new Int8Array(SIZE * SIZE);
  let lastMove = -1;
  let winLine = null;        // 获胜连线（下标数组）
  let interactive = false;   // 人回合才给悬停预览与手型光标
  let hoverIdx = -1;
  let anim = null;           // { idx, start } 落子动画
  let cssW = 0, cssH = 0, dpr = 1;
  let layout = null;         // { pad, cell } 几何缓存

  // ── 尺寸与几何 ──

  function resize() {
    const rect = canvas.getBoundingClientRect();
    cssW = rect.width;
    cssH = rect.height;
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    // 网格边距：留出坐标标注的空间（约 1.2 格）
    const pad = Math.max(18, Math.min(cssW, cssH) / 13.5);
    layout = { pad: pad, cell: (Math.min(cssW, cssH) - pad * 2) / (SIZE - 1) };
    render();
  }

  function pointOf(idx) {
    const col = idx % SIZE, row = Math.floor(idx / SIZE);
    return {
      x: layout.pad + col * layout.cell,
      y: layout.pad + row * layout.cell
    };
  }

  function idxAt(x, y) {
    const col = Math.round((x - layout.pad) / layout.cell);
    const row = Math.round((y - layout.pad) / layout.cell);
    if (col < 0 || col >= SIZE || row < 0 || row >= SIZE) return -1;
    const px = layout.pad + col * layout.cell;
    const py = layout.pad + row * layout.cell;
    const dist = Math.hypot(x - px, y - py);
    return dist <= layout.cell * 0.42 ? row * SIZE + col : -1;
  }

  // ── 绘制 ──

  function render() {
    if (!layout || cssW <= 0) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    drawWood();
    drawGrid();
    drawCoordinates();
    drawStones();
    drawHover();
    drawWin();
  }

  function drawWood() {
    // 盘面木色 + 轻微纵向明暗条纹（纯程序化，无贴图）
    ctx.fillStyle = getCss('--color-board-wood', '#d8b57e');
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.fillStyle = getCss('--color-board-wood-dark', '#c9a468');
    for (let i = 0; i < 5; i++) {
      ctx.globalAlpha = 0.06;
      const y = (cssH / 5) * i + 8;
      ctx.fillRect(0, y, cssW, cssH / 14);
    }
    ctx.globalAlpha = 1;
  }

  function drawGrid() {
    const line = getCss('--color-board-line', '#6b4a2b');
    ctx.strokeStyle = line;
    ctx.lineWidth = Math.max(0.8, layout.cell / 34);
    // 外框略粗
    ctx.beginPath();
    for (let i = 0; i < SIZE; i++) {
      const p = layout.pad + i * layout.cell;
      ctx.moveTo(layout.pad, p); ctx.lineTo(cssW - layout.pad, p);          // 横线
      ctx.moveTo(p, layout.pad); ctx.lineTo(p, cssH - layout.pad);          // 竖线
    }
    ctx.stroke();
    ctx.lineWidth = Math.max(1.4, layout.cell / 20);
    ctx.strokeRect(layout.pad, layout.pad, layout.cell * (SIZE - 1), layout.cell * (SIZE - 1));

    // 星位
    ctx.fillStyle = line;
    for (const [c, r] of STAR_POINTS) {
      const p = pointOf(r * SIZE + c);
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(2.4, layout.cell / 9), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawCoordinates() {
    const fontSize = Math.max(8, layout.cell / 3.2);
    ctx.fillStyle = getCss('--color-board-line', '#6b4a2b');
    ctx.font = `600 ${fontSize}px -apple-system, "Segoe UI", Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // 列 A..O 底部
    for (let c = 0; c < SIZE; c++) {
      ctx.fillText('ABCDEFGHIJKLMNO'[c], layout.pad + c * layout.cell, cssH - layout.pad / 2);
    }
    // 行 1..15 左侧（row 0 在最上 = 15）
    for (let r = 0; r < SIZE; r++) {
      ctx.fillText(String(SIZE - r), layout.pad / 2, layout.pad + r * layout.cell);
    }
  }

  function drawStones() {
    const radius = layout.cell * 0.44;
    for (let idx = 0; idx < boardArr.length; idx++) {
      const color = boardArr[idx];
      if (color === EMPTY) continue;
      const p = pointOf(idx);
      let scale = 1, alpha = 1;
      if (anim && anim.idx === idx) {
        const t = Math.min(1, (performance.now() - anim.start) / 120);
        scale = 1.35 - 0.35 * t;
        alpha = 0.55 + 0.45 * t;
      }
      drawStone(p.x, p.y, radius * scale, color, alpha);
      // 最后一手：红点标记（不依赖颜色也能看出来）
      if (idx === lastMove) {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color === BLACK ? '#ff5a4e' : '#c0392b';
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius * 0.22, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }

  function drawStone(x, y, radius, color, alpha) {
    ctx.globalAlpha = alpha;
    if (color === BLACK) {
      const g = ctx.createRadialGradient(x - radius * 0.35, y - radius * 0.35, radius * 0.1, x, y, radius);
      g.addColorStop(0, '#5a5f6a');
      g.addColorStop(0.35, '#2c2f36');
      g.addColorStop(1, getCss('--color-stone-black', '#17181c'));
      ctx.fillStyle = g;
    } else {
      const g = ctx.createRadialGradient(x - radius * 0.35, y - radius * 0.35, radius * 0.1, x, y, radius);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.7, getCss('--color-stone-white', '#f4f2ec'));
      g.addColorStop(1, '#cfc9bd');
      ctx.fillStyle = g;
    }
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    // 黑子加一个细描边增强轮廓；白子描边本身就是对比
    ctx.lineWidth = Math.max(0.7, radius / 14);
    ctx.strokeStyle = color === BLACK ? 'rgba(0,0,0,0.55)' : 'rgba(120,110,95,0.65)';
    ctx.stroke();
    // 投影
    ctx.globalAlpha = alpha * 0.25;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.ellipse(x + radius * 0.08, y + radius * 0.16, radius * 0.98, radius * 0.9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function drawHover() {
    if (!interactive || hoverIdx < 0 || boardArr[hoverIdx] !== EMPTY || winLine) return;
    const p = pointOf(hoverIdx);
    // 轮到谁走预览就画谁（偶数手黑）
    const color = moveCountOf() % 2 === 0 ? BLACK : 2;
    ctx.globalAlpha = 0.45;
    drawStone(p.x, p.y, layout.cell * 0.44, color, 1);
    ctx.globalAlpha = 1;
  }

  function moveCountOf() {
    let n = 0;
    for (let i = 0; i < boardArr.length; i++) if (boardArr[i] !== EMPTY) n++;
    return n;
  }

  function drawWin() {
    if (!winLine || winLine.length < 2) return;
    const a = pointOf(winLine[0]);
    const b = pointOf(winLine[winLine.length - 1]);
    const color = getCss('--color-win-line', '#e74c3c');

    // 获胜棋子高亮描边
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, layout.cell / 11);
    for (const idx of winLine) {
      const p = pointOf(idx);
      ctx.beginPath();
      ctx.arc(p.x, p.y, layout.cell * 0.44 + ctx.lineWidth * 0.6, 0, Math.PI * 2);
      ctx.stroke();
    }
    // 首尾连线
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(3, layout.cell / 7);
    ctx.lineCap = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = layout.cell * 0.35;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }

  // ── 动画驱动 ──

  function tick() {
    if (anim) {
      const t = (performance.now() - anim.start) / 120;
      if (t >= 1) anim = null;
      render();
      if (anim) requestAnimationFrame(tick);
    }
  }

  // ── 事件 ──

  canvas.addEventListener('click', (ev) => {
    if (!interactive) return;
    const rect = canvas.getBoundingClientRect();
    const idx = idxAt(ev.clientX - rect.left, ev.clientY - rect.top);
    if (idx < 0) return;
    if (handlers.canPlace && !handlers.canPlace(idx)) return;
    handlers.onPlace(idx);
  });

  canvas.addEventListener('mousemove', (ev) => {
    if (!interactive) return;
    const rect = canvas.getBoundingClientRect();
    const idx = idxAt(ev.clientX - rect.left, ev.clientY - rect.top);
    if (idx !== hoverIdx) {
      hoverIdx = idx;
      render();
    }
  });

  canvas.addEventListener('mouseleave', () => {
    if (hoverIdx >= 0) {
      hoverIdx = -1;
      render();
    }
  });

  // ── CSS 变量读取（token 改了画布跟着改）──

  function getCss(name, fallback) {
    const v = getComputedStyle(canvas).getPropertyValue(name).trim();
    return v || fallback;
  }

  // ── 对外 API ──

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  return {
    /** 用 rules.js 的 game 对象刷新整个局面（触发落子动画） */
    setPosition(game, animateLast) {
      boardArr = Int8Array.from(game.board);
      lastMove = game.moves.length ? game.moves[game.moves.length - 1] : -1;
      winLine = game.winLine;
      hoverIdx = -1;
      if (animateLast && lastMove >= 0) {
        anim = { idx: lastMove, start: performance.now() };
        requestAnimationFrame(tick);
      }
      canvas.setAttribute('aria-label',
        game.over
          ? '对局已结束'
          : `第 ${game.moves.length + 1} 手，轮到${game.moves.length % 2 === 0 ? '黑方' : '白方'}`);
      render();
    },
    /** 人回合开关：控制手型光标与悬停预览 */
    setInteractive(b) {
      interactive = b;
      canvas.parentElement && canvas.parentElement.classList.toggle('interactive', b);
      if (!b && hoverIdx >= 0) {
        hoverIdx = -1;
        render();
      }
    },
    redraw: render
  };
}
