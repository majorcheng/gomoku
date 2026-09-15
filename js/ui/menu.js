/**
 * menu.js - 多级菜单遮罩与对局总结浮层
 *
 * 菜单流（在棋盘遮罩里翻页）：
 *   主菜单 ──开始──▶ 模式选择 ──人机──▶ 执子选择 ──▶ 难度选择 ──开始对局──▶ 回调
 *                        │─本机双人──▶ 直接开始（五子棋双人无需选边）
 *                        │─机机对战──▶ 难度选择（双方同档）──开始对局──▶ 回调
 *                        └─说明──▶ 帮助页
 *
 * 难度按钮从 Difficulty.LEVELS 动态生成，不硬编码文案；
 * 选择记在 localStorage，下次打开默认停在上次档位。
 *
 * @license MIT
 */

const Difficulty = window.Difficulty;

const LEVEL_KEY = 'gomoku-level';

const $ = (id) => document.getElementById(id);

function show(page) { page.classList.remove('hide'); }
function hide(page) { page.classList.add('hide'); }

/**
 * 初始化菜单。
 * @param {{ onStart:function({mode:string, humanColor:number, level:number}):void,
 *          onSummaryRestart:function():void,
 *          onSummaryClose:function():void }} cb
 */
export function initMenu(cb) {
  const pages = {
    main: $('menu-main'),
    mode: $('menu-mode'),
    color: $('menu-color'),
    level: $('menu-level'),
    help: $('menu-help')
  };
  let mode = 'pve';

  // ── 难度选择页：档位按钮动态生成 ──
  const picker = $('level-picker');
  const desc = $('level-desc');
  let selectedLevel = loadLevel();

  Difficulty.LEVELS.forEach((def) => {
    const btn = document.createElement('button');
    btn.className = 'level-btn';
    btn.textContent = `${def.level} · ${def.label}`;
    btn.addEventListener('click', () => {
      selectedLevel = def.level;
      refreshPicker();
    });
    btn.dataset.level = String(def.level);
    picker.appendChild(btn);
  });

  function refreshPicker() {
    picker.querySelectorAll('.level-btn').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.level) === selectedLevel);
    });
    desc.textContent = Difficulty.getLevel(selectedLevel).desc;
  }
  refreshPicker();

  function loadLevel() {
    const v = Number(localStorage.getItem(LEVEL_KEY));
    return Difficulty.LEVELS.some((l) => l.level === v) ? v : Difficulty.DEFAULT_LEVEL;
  }

  function saveLevel() {
    try { localStorage.setItem(LEVEL_KEY, String(selectedLevel)); } catch (err) { /* 忽略 */ }
  }

  // ── 翻页逻辑 ──
  function goto(name) {
    Object.values(pages).forEach(hide);
    show(pages[name]);
  }

  $('startbtn').addEventListener('click', () => goto('mode'));
  $('helpbtn').addEventListener('click', () => goto('help'));

  $('pvebtn').addEventListener('click', () => { mode = 'pve'; goto('color'); });
  $('pvpbtn').addEventListener('click', () => {
    // 本机双人：无需执子与难度，直接开局
    hideOverlay();
    cb.onStart({ mode: 'pvp', humanColor: 1, level: 0 });
  });
  $('evebtn').addEventListener('click', () => { mode = 'eve'; goto('level'); });

  let chosenColor = 1;   // 执子选择：1 黑先行，2 白后行

  $('pfbtn').addEventListener('click', () => { chosenColor = 1; goto('level'); });
  $('efbtn').addEventListener('click', () => { chosenColor = 2; goto('level'); });

  $('levelstart').addEventListener('click', () => {
    saveLevel();
    hideOverlay();
    cb.onStart({
      mode,
      humanColor: mode === 'pve' ? chosenColor : 1,
      level: selectedLevel
    });
  });

  // 返回按钮：难度页在 pve 下回执子页，其他回模式页
  document.querySelectorAll('.returnbtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const back = btn.dataset.back;     // 'main' | 'mode' | 'color'
      goto(back === 'color' && mode !== 'pve' ? 'mode' : back);
    });
  });

  // ── 对局总结浮层 ──
  $('summary-restart').addEventListener('click', () => {
    hide($('game-summary'));
    cb.onSummaryRestart();
  });
  $('summary-close').addEventListener('click', () => hide($('game-summary')));
}

/** 隐藏整个棋盘遮罩（开局） */
export function hideOverlay() {
  hide($('board-options'));
}

/** 显示棋盘遮罩（回到菜单） */
export function showOverlay() {
  // 回到主菜单页，翻页状态复位
  ['menu-mode', 'menu-color', 'menu-level', 'menu-help'].forEach((id) => hide($(id)));
  show($('menu-main'));
  show($('board-options'));
}

/**
 * 弹出对局总结浮层。
 * @param {{title:string, text:string}} content
 */
export function showSummary(content) {
  $('game-summary-title').textContent = content.title;
  $('game-summary-text').innerHTML = content.text;
  show($('game-summary'));
}

/** 收起对局总结浮层（保留棋盘上的胜利连线供复盘） */
export function hideSummary() {
  hide($('game-summary'));
}

/** 通用 toast */
let toastTimer = null;
export function showToast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('hide');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hide'), 2200);
}
