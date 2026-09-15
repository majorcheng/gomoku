/**
 * rules.js - 裁判层（主线程的规则权威）
 *
 * 只管"棋盘上发生了什么"：落子是否合法、是否触发禁手、是否形成五连、是否满盘、
 * 悔棋退几步、坐标怎么念。不做任何 AI 判断，也不碰 DOM。
 *
 * 棋盘表示：15×15 一维数组，index = row * 15 + col。
 *   0 = 空，1 = 黑，2 = 白。黑先行。
 * 坐标记法：列 A..O（左→右，col 0..14），行 1..15（下→上，row 0 = 第 15 行
 * 靠上……不，这里取 row 0 在**上**、行号 15 在下，与棋谱习惯一致：
 * 天元是 col 7 / row 7 → index 112 → "H8"。
 *
 * @license MIT
 */

export const SIZE = 15;
export const AREA = SIZE * SIZE;
export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;

export const FORBIDDEN = Object.freeze({
  OVERLINE: 'overline',
  DOUBLE_FOUR: 'double-four',
  DOUBLE_THREE: 'double-three'
});

/** 四个方向的行进增量（col, row）：横、竖、右下斜、右上斜 */
const DIRS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1]
];

/** 天元（棋盘正中） */
export const CENTER = 7 * SIZE + 7;

/** 列名 A..O */
const COL_NAMES = 'ABCDEFGHIJKLMNO';

/**
 * 下标 ↔ 坐标名互转。index 112 ↔ "H8"。
 * 行号显示为 15 - row：row 0（最上面一行）是第 15 行。
 */
export function coordName(index) {
  const col = index % SIZE;
  const row = Math.floor(index / SIZE);
  return COL_NAMES[col] + (SIZE - row);
}

export function indexFromCoord(name) {
  if (!/^[A-O](?:[1-9]|1[0-5])$/.test(name)) return -1;
  const col = COL_NAMES.indexOf(name[0]);
  const rowNum = parseInt(name.slice(1), 10);
  return (SIZE - rowNum) * SIZE + col;
}

/** 判断下标是否在棋盘内（配合斜向行进时使用） */
export function inBounds(col, row) {
  return col >= 0 && col < SIZE && row >= 0 && row < SIZE;
}

function lineAt(board, index, color, dc, dr) {
  const col0 = index % SIZE;
  const row0 = Math.floor(index / SIZE);
  let count = 1;
  for (let c = col0 + dc, r = row0 + dr; inBounds(c, r) && board[r * SIZE + c] === color; c += dc, r += dr) count++;
  for (let c = col0 - dc, r = row0 - dr; inBounds(c, r) && board[r * SIZE + c] === color; c -= dc, r -= dr) count++;
  return count;
}

function lineIndices(index, dc, dr) {
  const result = [];
  let col = index % SIZE;
  let row = Math.floor(index / SIZE);
  while (inBounds(col - dc, row - dr)) {
    col -= dc;
    row -= dr;
  }
  while (inBounds(col, row)) {
    result.push(row * SIZE + col);
    col += dc;
    row += dr;
  }
  return result;
}

function winningLine(board, index, color, dc, dr) {
  if (board[index] !== color) return null;
  const count = lineAt(board, index, color, dc, dr);
  if (count < 5) return null;

  const line = [index];
  const col0 = index % SIZE;
  const row0 = Math.floor(index / SIZE);
  for (let c = col0 + dc, r = row0 + dr; inBounds(c, r) && board[r * SIZE + c] === color; c += dc, r += dr) {
    line.push(r * SIZE + c);
  }
  for (let c = col0 - dc, r = row0 - dr; inBounds(c, r) && board[r * SIZE + c] === color; c -= dc, r -= dr) {
    line.unshift(r * SIZE + c);
  }
  return line;
}

function collectFourGroups(board, origin, color, dc, dr, required = -1) {
  const threats = [];
  for (const completion of lineIndices(origin, dc, dr)) {
    if (board[completion] !== EMPTY) continue;
    board[completion] = color;
    const line = winningLine(board, completion, color, dc, dr);
    board[completion] = EMPTY;
    if (!line || line.length !== 5 || !line.includes(origin) || (required >= 0 && !line.includes(required))) continue;
    threats.push({ completion, line });
  }

  // 两个端点都能完成的同一个活四只算一个四，避免把 .XXXX. 误判为双四。
  const groups = [];
  for (const threat of threats) {
    const cells = new Set(threat.line);
    const group = groups.find((items) => {
      let shared = 0;
      for (const cell of items[0].line) if (cells.has(cell)) shared++;
      return shared >= 4;
    });
    if (group) group.push(threat);
    else groups.push([threat]);
  }
  return groups;
}

function collectFourThreats(board, origin, color, dc, dr, required = -1) {
  return collectFourGroups(board, origin, color, dc, dr, required).length;
}

function createsOpenThree(board, origin, color, dc, dr) {
  // ponytail: 采用一步形成活四的识别，赛事级递归判例需升级为标准棋型表/裁判器。
  let extensions = 0;
  for (const extension of lineIndices(origin, dc, dr)) {
    if (board[extension] !== EMPTY) continue;
    board[extension] = color;
    const immediateWin = lineAt(board, extension, color, dc, dr) >= 5;
    const makesFour = !immediateWin && collectFourGroups(board, origin, color, dc, dr, extension)
      .some((group) => group.length >= 2);
    board[extension] = EMPTY;
    if (makesFour && ++extensions >= 2) return true;
  }
  return false;
}

function forbiddenReasonAfterPlace(board, index) {
  for (const [dc, dr] of DIRS) {
    if (lineAt(board, index, BLACK, dc, dr) > 5) return FORBIDDEN.OVERLINE;
  }

  // 恰好五连优先于三三/四四；长连已经在上面作为禁手拦截。
  if (DIRS.some(([dc, dr]) => lineAt(board, index, BLACK, dc, dr) === 5)) return null;

  let fours = 0;
  let threes = 0;
  for (const [dc, dr] of DIRS) {
    fours += collectFourThreats(board, index, BLACK, dc, dr);
    if (createsOpenThree(board, index, BLACK, dc, dr)) threes++;
  }
  if (fours >= 2) return FORBIDDEN.DOUBLE_FOUR;
  if (threes >= 2) return FORBIDDEN.DOUBLE_THREE;
  return null;
}

/**
 * 判断黑方在空点落子是否触发连珠禁手。
 * 白方没有禁手；返回 null 表示允许，返回 FORBIDDEN 中的值表示拒绝原因。
 */
export function forbiddenReason(board, index, color = BLACK) {
  if (color !== BLACK || !Number.isInteger(index) || index < 0 || index >= AREA || board[index] !== EMPTY) return null;
  board[index] = BLACK;
  const reason = forbiddenReasonAfterPlace(board, index);
  board[index] = EMPTY;
  return reason;
}

export function forbiddenName(reason) {
  return reason === FORBIDDEN.OVERLINE ? '长连' :
    reason === FORBIDDEN.DOUBLE_FOUR ? '双四' :
      reason === FORBIDDEN.DOUBLE_THREE ? '双三' : '禁手';
}

/**
 * 从"刚落的子"出发，检查是否形成五连或长连。
 *
 * 只需要从落点向四个方向数——之前没赢现在才可能刚赢，这是五子棋
 * 判胜的经典优化，O(4×9) 而非全盘扫描。
 *
 * @returns {Array<number>|null} 获胜的整条连线（按顺序的下标数组），未胜返回 null
 */
export function checkFive(board, index) {
  const color = board[index];
  if (color === EMPTY) return null;
  const col0 = index % SIZE;
  const row0 = Math.floor(index / SIZE);

  for (let d = 0; d < DIRS.length; d++) {
    const [dc, dr] = DIRS[d];
    // 正向数连续同色
    const line = [index];
    for (let c = col0 + dc, r = row0 + dr; inBounds(c, r) && board[r * SIZE + c] === color; c += dc, r += dr) {
      line.push(r * SIZE + c);
    }
    // 反向数
    for (let c = col0 - dc, r = row0 - dr; inBounds(c, r) && board[r * SIZE + c] === color; c -= dc, r -= dr) {
      line.unshift(r * SIZE + c);
    }
    if (line.length >= 5) return line;
  }
  return null;
}

/**
 * 创建一局新游戏。返回的 game 对象是唯一的局面事实来源，
 * app.js 与 panel.js 都从它读信息，落子/悔棋都通过本模块的方法进行。
 */
export function createGame() {
  return {
    board: new Int8Array(AREA),   // Int8Array(225)
    moves: [],                    // 已落子的下标序列，长度即手数
    over: false,                  // 终局标记
    winner: 0,                    // 0 = 未定/和棋，1 = 黑，2 = 白
    winLine: null                 // 获胜连线（下标数组），和棋为 null
  };
}

/** 当前行棋方（未落子数决定：偶数手黑） */
export function turnOf(game) {
  return game.moves.length % 2 === 0 ? BLACK : WHITE;
}

/**
 * 在 index 处为当前行棋方落子。
 *
 * @returns {{legal: boolean, win: boolean, full: boolean, forbidden?: boolean, reason?: string}}
 *   legal - 是否真的落了（终局/占用/越界都拒绝）
 *   win   - 这一手是否获胜（winLine 已写回 game）
 *   full  - 是否满盘和棋（over 已写回 game）
 *   forbidden - 是否因黑方禁手拒绝
 *   reason - 禁手原因（见 FORBIDDEN）
 */
export function place(game, index) {
  if (game.over) return { legal: false, win: false, full: false };
  if (!Number.isInteger(index) || index < 0 || index >= AREA) return { legal: false, win: false, full: false };
  if (game.board[index] !== EMPTY) return { legal: false, win: false, full: false };

  const color = turnOf(game);
  const forbidden = forbiddenReason(game.board, index, color);
  if (forbidden) {
    return { legal: false, win: false, full: false, forbidden: true, reason: forbidden };
  }
  game.board[index] = color;
  game.moves.push(index);

  const line = checkFive(game.board, index);
  if (line) {
    game.over = true;
    game.winner = color;
    game.winLine = line;
    return { legal: true, win: true, full: false };
  }

  if (game.moves.length === AREA) {
    game.over = true;
    game.winner = 0;
    return { legal: true, win: false, full: true };
  }

  return { legal: true, win: false, full: false };
}

/**
 * 撤回 n 步（撤完自动清除终局状态，允许"悔掉最后一手获胜棋"）。
 * 实际撤回步数会 clamp 到已有手数。
 * @returns 实际撤回的步数
 */
export function undo(game, n) {
  const count = Math.max(0, Math.min(n, game.moves.length));
  for (let i = 0; i < count; i++) {
    game.board[game.moves.pop()] = EMPTY;
  }
  game.over = false;
  game.winner = 0;
  game.winLine = null;
  return count;
}

/** 颜色数字 → 中文名（面板显示用） */
export function colorName(color) {
  return color === BLACK ? '黑方' : color === WHITE ? '白方' : '—';
}
