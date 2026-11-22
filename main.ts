// Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
// Strategy (written from scratch for this bounty):
//   The generator builds a one-cell-wide hallway with 1-4 rooms off it, each
//   room holding 3-4 boxes and as many goals, joined to the hallway by a
//   single door. A box pushed out of its room can never come back, so the
//   level optimum is the sum of the rooms' optima. We therefore
//     1. split the level into rooms (connected components of the floor off
//        the hallway row/column that holds the player start),
//     2. solve each room independently with a push-based A* search
//        (admissible assignment heuristic over box-to-goal walking
//        distances, dead-cell and freeze pruning, transposition table with
//        canonical player position), which is push-optimal per room,
//     3. stitch the rooms together with ordinary player walks through the
//        (always box-free) hallway.
//   Search budgets are counted in node expansions, never wall-clock time,
//   so two runs produce byte-identical output.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Fixed move order: up, down, left, right. Every iteration in this file
// follows fixed orders, so the program is fully deterministic.
const DIRS = [
  { dr: -1, dc: 0, ch: 'u' },
  { dr: 1, dc: 0, ch: 'd' },
  { dr: 0, dc: -1, ch: 'l' },
  { dr: 0, dc: 1, ch: 'r' },
] as const;

type Level = {
  w: number;
  h: number;
  wall: Uint8Array; // 1 = wall, per cell index r*w+c
  floor: Uint8Array; // 1 = walkable floor
  goals: Set<number>;
  boxes: number[];
  player: number;
};

function parseLevel(text: string): Level {
  const lines = text.replace(/\r/g, '').split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const h = lines.length;
  let w = 0;
  for (const l of lines) w = Math.max(w, l.length);
  const wall = new Uint8Array(w * h);
  const floor = new Uint8Array(w * h);
  const goals = new Set<number>();
  const boxes: number[] = [];
  let player = -1;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const ch = c < lines[r].length ? lines[r][c] : '#';
      const i = r * w + c;
      if (ch === '#') {
        wall[i] = 1;
      } else {
        floor[i] = 1;
        if (ch === '.' || ch === '*') goals.add(i);
        if (ch === '$' || ch === '*') boxes.push(i);
        if (ch === '@' || ch === '+') player = i;
      }
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, wall, floor, goals, boxes, player };
}

// Breadth-first distances from `from` over cells where allowed[i] is 1.
function bfsDist(from: number, allowed: Uint8Array, w: number): Int32Array {
  const dist = new Int32Array(allowed.length).fill(-1);
  const q: number[] = [from];
  dist[from] = 0;
  let head = 0;
  while (head < q.length) {
    const cur = q[head++];
    const r = Math.floor(cur / w);
    const c = cur % w;
    for (const d of DIRS) {
      const nr = r + d.dr;
      const nc = c + d.dc;
      if (nr < 0 || nc < 0) continue;
      const ni = nr * w + nc;
      if (ni >= allowed.length || !allowed[ni] || dist[ni] !== -1) continue;
      dist[ni] = dist[cur] + 1;
      q.push(ni);
    }
  }
  return dist;
}

// Flood fill from `from` over allowed cells avoiding blocked cells.
// Returns a mask (1 = reachable).
function flood(from: number, allowed: Uint8Array, blocked: Uint8Array, w: number): Uint8Array {
  const seen = new Uint8Array(allowed.length);
  if (!allowed[from] || blocked[from]) return seen;
  const q: number[] = [from];
  seen[from] = 1;
  let head = 0;
  while (head < q.length) {
    const cur = q[head++];
    const r = Math.floor(cur / w);
    const c = cur % w;
    for (const d of DIRS) {
      const nr = r + d.dr;
      const nc = c + d.dc;
      if (nr < 0 || nc < 0) continue;
      const ni = nr * w + nc;
      if (ni >= allowed.length || !allowed[ni] || blocked[ni] || seen[ni]) continue;
      seen[ni] = 1;
      q.push(ni);
    }
  }
  return seen;
}

// Shortest player walk from `from` to `to` over allowed cells, avoiding
// blocked cells. Returns the move string, or null when unreachable.
function bfsPath(
  from: number,
  to: number,
  allowed: Uint8Array,
  blocked: Uint8Array,
  w: number,
): string | null {
  if (from === to) return '';
  const prev = new Int32Array(allowed.length).fill(-2);
  const prevCh = new Array<string>(allowed.length).fill('');
  const q: number[] = [from];
  prev[from] = -1;
  let head = 0;
  while (head < q.length) {
    const cur = q[head++];
    if (cur === to) break;
    const r = Math.floor(cur / w);
    const c = cur % w;
    for (const d of DIRS) {
      const nr = r + d.dr;
      const nc = c + d.dc;
      if (nr < 0 || nc < 0) continue;
      const ni = nr * w + nc;
      if (ni >= allowed.length || !allowed[ni] || blocked[ni] || prev[ni] !== -2) continue;
      prev[ni] = cur;
      prevCh[ni] = d.ch;
      q.push(ni);
    }
  }
  if (prev[to] === -2) return null;
  let out = '';
  let cur = to;
  while (cur !== from) {
    out = prevCh[cur] + out;
    cur = prev[cur];
  }
  return out;
}

// ---- room splitting -------------------------------------------------------

type Room = {
  cells: number[]; // room floor cells (component off the hallway)
  boxArea: Uint8Array; // cells a box may occupy (room cells + attached hallway box cells)
  playerArea: Uint8Array; // cells the player may stand on while solving the room
  goals: number[];
  boxes: number[];
  entry: number; // hallway cell the player stands on to enter the room
  door: number; // first room cell adjacent to the entry cell
};

// Split the level into rooms for one hallway orientation.
// horizontal: hallway is the player's row; vertical: the player's column.
// Returns null when the orientation does not cleanly explain the level.
function detectRooms(level: Level, horizontal: boolean): Room[] | null {
  const { w, h, floor, goals, boxes, player } = level;
  const pr = Math.floor(player / w);
  const pc = player % w;
  const isHall = (i: number): boolean => {
    const r = Math.floor(i / w);
    const c = i % w;
    return horizontal ? r === pr : c === pc;
  };
  // The hallway run containing the player: floor cells in the hallway line.
  const hallCells: number[] = [];
  if (horizontal) {
    for (let c = 0; c < w; c++) {
      const i = pr * w + c;
      if (floor[i]) hallCells.push(i);
    }
  } else {
    for (let r = 0; r < h; r++) {
      const i = r * w + pc;
      if (floor[i]) hallCells.push(i);
    }
  }
  if (hallCells.length === 0) return null;
  const hallSet = new Set(hallCells);
  // A hallway cell must connect to the player through hallway cells only.
  const hallReach = flood(player, level.floor, new Uint8Array(w * h), w);
  for (const i of hallCells) {
    if (!hallReach[i]) return null;
  }
  // Components of the floor with hallway cells removed.
  const seen = new Uint8Array(w * h);
  const rooms: Room[] = [];
  const boxSet = new Set(boxes);
  const goalArr = [...goals];
  const coveredGoals = new Set<number>();
  const coveredBoxes = new Set<number>();
  for (let s = 0; s < w * h; s++) {
    if (!floor[s] || hallSet.has(s) || seen[s]) continue;
    const comp: number[] = [];
    const q: number[] = [s];
    seen[s] = 1;
    let head = 0;
    while (head < q.length) {
      const cur = q[head++];
      comp.push(cur);
      const r = Math.floor(cur / w);
      const c = cur % w;
      for (const d of DIRS) {
        const nr = r + d.dr;
        const nc = c + d.dc;
        if (nr < 0 || nc < 0 || nr >= h || nc >= w) continue;
        const ni = nr * w + nc;
        if (!floor[ni] || hallSet.has(ni) || seen[ni]) continue;
        seen[ni] = 1;
        q.push(ni);
      }
    }
    const compSet = new Set(comp);
    const compGoals = goalArr.filter((g) => compSet.has(g));
    const compBoxes = boxes.filter((b) => compSet.has(b));
    if (compGoals.length === 0) {
      // A box-less, goal-less pocket off the hallway: harmless, ignore it
      // only when it holds no boxes either.
      if (compBoxes.length > 0) return null;
      continue;
    }
    if (compGoals.length !== compBoxes.length) return null;
    if (compBoxes.length > 6) return null; // too big for one room; not this shape
    // Door cells: component cells adjacent to a hallway cell.
    let door = -1;
    let entry = -1;
    const sorted = [...comp].sort((a, b) => a - b);
    outer: for (const cell of sorted) {
      const r = Math.floor(cell / w);
      const c = cell % w;
      for (const d of DIRS) {
        const nr = r + d.dr;
        const nc = c + d.dc;
        if (nr < 0 || nc < 0 || nr >= h || nc >= w) continue;
        const ni = nr * w + nc;
        if (hallSet.has(ni)) {
          door = cell;
          entry = ni;
          break outer;
        }
      }
    }
    if (door === -1) return null;
    const boxArea = new Uint8Array(w * h);
    const playerArea = new Uint8Array(w * h);
    for (const cell of comp) {
      boxArea[cell] = 1;
      playerArea[cell] = 1;
    }
    playerArea[entry] = 1;
    // Boxes sitting on hallway cells adjacent to this room belong to it.
    for (const b of boxes) {
      if (hallSet.has(b) && !coveredBoxes.has(b)) {
        const r = Math.floor(b / w);
        const c = b % w;
        let touches = false;
        for (const d of DIRS) {
          const nr = r + d.dr;
          const nc = c + d.dc;
          if (nr < 0 || nc < 0 || nr >= h || nc >= w) continue;
          if (compSet.has(nr * w + nc)) touches = true;
        }
        if (touches) {
          boxArea[b] = 1;
          playerArea[b] = 1;
          compBoxes.push(b);
        }
      }
    }
    if (compGoals.length !== compBoxes.length) return null;
    for (const g of compGoals) coveredGoals.add(g);
    for (const b of compBoxes) coveredBoxes.add(b);
    compBoxes.sort((a, b) => a - b);
    compGoals.sort((a, b) => a - b);
    rooms.push({ cells: comp, boxArea, playerArea, goals: compGoals, boxes: compBoxes, entry, door });
  }
  // Every goal and every box must be accounted for.
  for (const g of goals) if (!coveredGoals.has(g)) return null;
  for (const b of boxes) if (!coveredBoxes.has(b) && !boxSet.has(b)) return null;
  for (const b of boxes) if (!coveredBoxes.has(b)) return null;
  if (rooms.length === 0) return null;
  rooms.sort((a, b) => a.entry - b.entry);
  return rooms;
}

// ---- push search (per room, or whole level as fallback) --------------------

type Push = { from: number; dir: number }; // dir indexes DIRS

type SearchCtx = {
  w: number;
  boxArea: Uint8Array;
  playerArea: Uint8Array;
  goals: number[];
  goalSet: Set<number>;
  // dist[g][cell]: walking distance from goal g over boxArea cells.
  dist: Int32Array[];
  // live[cell]: cell is connected to a goal through boxArea cells.
  live: Uint8Array;
  budget: { used: number; limit: number };
};

// Minimum-assignment heuristic: for <=5 boxes, exact assignment by
// enumerating permutations; otherwise the sum of per-box minima. Both are
// admissible lower bounds on the pushes still needed. Returns Infinity
// when some box cannot reach any goal.
function heuristic(ctx: SearchCtx, boxes: number[]): number {
  const n = boxes.length;
  const m = ctx.goals.length;
  if (n === 0) return 0;
  // cost[i][j] = distance of box i to goal j
  const cost: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    let best = Infinity;
    for (let j = 0; j < m; j++) {
      const d = ctx.dist[j][boxes[i]];
      row.push(d === -1 ? Infinity : d);
      if (d !== -1 && d < best) best = d;
    }
    if (best === Infinity) return Infinity;
    cost.push(row);
  }
  if (n <= 5 && n === m) {
    // Exact assignment by permutation enumeration (n! <= 120).
    const perm: number[] = [];
    for (let j = 0; j < m; j++) perm.push(j);
    let best = Infinity;
    const rec = (k: number, acc: number): void => {
      if (acc >= best) return;
      if (k === n) {
        best = acc;
        return;
      }
      for (let j = k; j < m; j++) {
        const c = cost[k][perm[j]];
        if (c === Infinity) continue;
        const tmp = perm[k];
        perm[k] = perm[j];
        perm[j] = tmp;
        rec(k + 1, acc + c);
        const tmp2 = perm[k];
        perm[k] = perm[j];
        perm[j] = tmp2;
      }
    };
    rec(0, 0);
    return best;
  }
  let sum = 0;
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    for (let j = 0; j < m; j++) if (cost[i][j] < best) best = cost[i][j];
    sum += best;
  }
  return sum;
}

// A box not on a goal is frozen when no push is geometrically possible even
// ignoring other boxes (destination inside the box area and the stand cell
// inside the player area). Such a box can never move again.
function isFrozen(ctx: SearchCtx, box: number): boolean {
  if (ctx.goalSet.has(box)) return false;
  const r = Math.floor(box / ctx.w);
  const c = box % ctx.w;
  for (const d of DIRS) {
    const dr2 = r + d.dr;
    const dc2 = c + d.dc;
    const sr = r - d.dr;
    const sc = c - d.dc;
    if (dr2 < 0 || dc2 < 0 || sr < 0 || sc < 0) continue;
    const dest = dr2 * ctx.w + dc2;
    const stand = sr * ctx.w + sc;
    if (dest >= ctx.boxArea.length || stand >= ctx.playerArea.length) continue;
    if (ctx.boxArea[dest] && ctx.playerArea[stand]) return false;
  }
  return true;
}

function isDead(ctx: SearchCtx, boxes: number[]): boolean {
  for (const b of boxes) {
    if (!ctx.goalSet.has(b) && !ctx.live[b]) return true;
    if (isFrozen(ctx, b)) return true;
  }
  return false;
}

// Binary min-heap ordered by (key, seq). `key` is f for A* and h for greedy.
type HeapItem = { key: number; h: number; seq: number; si: number; g: number };

function heapPush(heap: HeapItem[], item: HeapItem): void {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    const a = heap[p];
    const b = heap[i];
    if (a.key < b.key || (a.key === b.key && (a.h < b.h || (a.h === b.h && a.seq <= b.seq)))) break;
    heap[i] = a;
    heap[p] = b;
    i = p;
  }
}

function heapPop(heap: HeapItem[]): HeapItem {
  const top = heap[0];
  const last = heap.pop() as HeapItem;
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      const better = (x: HeapItem, y: HeapItem): boolean =>
        x.key < y.key || (x.key === y.key && (x.h < y.h || (x.h === y.h && x.seq < y.seq)));
      if (l < heap.length && better(heap[l], heap[m])) m = l;
      if (r < heap.length && better(heap[r], heap[m])) m = r;
      if (m === i) break;
      const tmp = heap[i];
      heap[i] = heap[m];
      heap[m] = tmp;
      i = m;
    }
  }
  return top;
}

type StateRec = {
  boxes: number[];
  player: number;
  g: number;
  parent: number;
  pushFrom: number;
  pushDir: number;
  key: string; // boxes + canonical reachable player cell (for dedup)
};

// Push-based search. mode 'astar' minimises pushes (optimal when it
// finishes); mode 'greedy' follows h alone to find a solution fast.
// Returns the push list, or null when the cap is hit / space exhausted.
function pushSearch(
  ctx: SearchCtx,
  startBoxes: number[],
  startPlayer: number,
  mode: 'astar' | 'greedy',
  cap: number,
): Push[] | null {
  const w = ctx.w;
  const states: StateRec[] = [];
  const startH = heuristic(ctx, startBoxes);
  if (startH === Infinity || isDead(ctx, startBoxes)) return null;
  const mkBlocked = (boxes: number[]): Uint8Array => {
    const b = new Uint8Array(ctx.playerArea.length);
    for (const x of boxes) b[x] = 1;
    return b;
  };
  // Canonical key: boxes + smallest cell reachable by the player.
  const canonKey = (boxes: number[], player: number): string => {
    const reach = flood(player, ctx.playerArea, mkBlocked(boxes), w);
    let canon = -1;
    for (let i = 0; i < reach.length; i++) {
      if (reach[i]) {
        canon = i;
        break;
      }
    }
    return boxes.join(',') + '|' + canon;
  };
  const startKey = canonKey(startBoxes, startPlayer);
  states.push({
    boxes: [...startBoxes],
    player: startPlayer,
    g: 0,
    parent: -1,
    pushFrom: -1,
    pushDir: -1,
    key: startKey,
  });
  const heap: HeapItem[] = [];
  let seq = 0;
  const visited = new Map<string, number>();
  visited.set(startKey, 0);
  heapPush(heap, { key: startH, h: startH, seq: seq++, si: 0, g: 0 });
  let expansions = 0;
  while (heap.length > 0) {
    if (expansions >= cap || ctx.budget.used >= ctx.budget.limit) return null;
    const item = heapPop(heap);
    const st = states[item.si];
    // Stale heap entry: a better path to this state key was recorded.
    if (visited.get(st.key) !== st.g) continue;
    expansions++;
    ctx.budget.used++;
    // Goal test: every box on a goal.
    let solved = true;
    for (const b of st.boxes) {
      if (!ctx.goalSet.has(b)) {
        solved = false;
        break;
      }
    }
    if (solved) {
      const pushes: Push[] = [];
      let cur = item.si;
      while (states[cur].parent !== -1) {
        pushes.push({ from: states[cur].pushFrom, dir: states[cur].pushDir });
        cur = states[cur].parent;
      }
      pushes.reverse();
      return pushes;
    }
    const blocked = mkBlocked(st.boxes);
    const reach = flood(st.player, ctx.playerArea, blocked, w);
    const boxSet = new Set(st.boxes);
    for (let bi = 0; bi < st.boxes.length; bi++) {
      const box = st.boxes[bi];
      const r = Math.floor(box / w);
      const c = box % w;
      for (let di = 0; di < DIRS.length; di++) {
        const d = DIRS[di];
        const dr2 = r + d.dr;
        const dc2 = c + d.dc;
        const sr = r - d.dr;
        const sc = c - d.dc;
        if (dr2 < 0 || dc2 < 0 || sr < 0 || sc < 0) continue;
        const dest = dr2 * w + dc2;
        const stand = sr * w + sc;
        if (dest >= ctx.boxArea.length || stand >= ctx.playerArea.length) continue;
        if (!ctx.boxArea[dest] || boxSet.has(dest)) continue;
        if (!reach[stand]) continue;
        const nb = [...st.boxes];
        nb[bi] = dest;
        nb.sort((a, b) => a - b);
        if (isDead(ctx, nb)) continue;
        const h = heuristic(ctx, nb);
        if (h === Infinity) continue;
        const ng = st.g + 1;
        const key = canonKey(nb, box);
        const prev = visited.get(key);
        if (prev !== undefined && prev <= ng) continue;
        visited.set(key, ng);
        const si = states.length;
        states.push({ boxes: nb, player: box, g: ng, parent: item.si, pushFrom: box, pushDir: di, key });
        heapPush(heap, {
          key: mode === 'astar' ? ng + h : h,
          h,
          seq: seq++,
          si,
          g: ng,
        });
      }
    }
  }
  return null;
}

function makeCtx(
  w: number,
  h: number,
  boxArea: Uint8Array,
  playerArea: Uint8Array,
  goals: number[],
  budget: { used: number; limit: number },
): SearchCtx {
  const goalSet = new Set(goals);
  const dist = goals.map((g) => bfsDist(g, boxArea, w));
  // Live cells: boxArea cells connected to a goal through boxArea cells.
  const live = new Uint8Array(w * h);
  const q: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    q.push(g);
  }
  let head = 0;
  while (head < q.length) {
    const cur = q[head++];
    const r = Math.floor(cur / w);
    const c = cur % w;
    for (const d of DIRS) {
      const nr = r + d.dr;
      const nc = c + d.dc;
      if (nr < 0 || nc < 0 || nr >= h || nc >= w) continue;
      const ni = nr * w + nc;
      if (!boxArea[ni] || live[ni]) continue;
      live[ni] = 1;
      q.push(ni);
    }
  }
  return { w, boxArea, playerArea, goals, goalSet, dist, live, budget };
}

// Expand a push list into player moves, walking between pushes.
// Player starts at `startPlayer`; boxes start at `startBoxes`.
// Walks stay inside playerArea; boxes only ever occupy boxArea cells.
function expandPushes(
  ctx: SearchCtx,
  startBoxes: number[],
  startPlayer: number,
  pushes: Push[],
): { moves: string; boxes: number[]; player: number } | null {
  const boxes = [...startBoxes];
  let player = startPlayer;
  let moves = '';
  for (const p of pushes) {
    const box = p.from;
    const d = DIRS[p.dir];
    const r = Math.floor(box / ctx.w);
    const c = box % ctx.w;
    const stand = (r - d.dr) * ctx.w + (c - d.dc);
    const dest = (r + d.dr) * ctx.w + (c + d.dc);
    const bi = boxes.indexOf(box);
    if (bi === -1) return null;
    const blocked = new Uint8Array(ctx.playerArea.length);
    for (const b of boxes) blocked[b] = 1;
    const walk = bfsPath(player, stand, ctx.playerArea, blocked, ctx.w);
    if (walk === null) return null;
    moves += walk;
    moves += d.ch;
    boxes[bi] = dest;
    boxes.sort((a, b) => a - b);
    player = box;
  }
  return { moves, boxes, player };
}

// Solve one room. Tries A* first (push-optimal), then greedy, then A* with
// the cheaper heuristic, all under deterministic expansion caps.
function solveRoom(
  ctx: SearchCtx,
  room: Room,
  budget: { used: number; limit: number },
): Push[] | null {
  const already = room.boxes.every((b) => ctx.goalSet.has(b));
  if (already) return [];
  const attempts: Array<{ mode: 'astar' | 'greedy'; cap: number }> = [
    { mode: 'astar', cap: 300000 },
    { mode: 'greedy', cap: 300000 },
    { mode: 'astar', cap: 600000 },
  ];
  for (const a of attempts) {
    if (budget.used >= budget.limit) return null;
    const cap = Math.min(a.cap, Math.max(0, budget.limit - budget.used));
    const res = pushSearch(ctx, room.boxes, room.entry, a.mode, cap);
    if (res !== null) return res;
  }
  return null;
}

// Replay a move string on the level; returns true only when every move is
// legal and all boxes end on goals.
function replay(level: Level, moves: string): boolean {
  const boxes = new Set(level.boxes);
  let player = level.player;
  const w = level.w;
  for (const ch of moves) {
    const d = DIRS.find((x) => x.ch === ch);
    if (!d) return false;
    const r = Math.floor(player / w);
    const c = player % w;
    const nr = r + d.dr;
    const nc = c + d.dc;
    if (nr < 0 || nc < 0 || nr >= level.h || nc >= w) return false;
    const ni = nr * w + nc;
    if (level.wall[ni]) return false;
    if (boxes.has(ni)) {
      const br = nr + d.dr;
      const bc = nc + d.dc;
      if (br < 0 || bc < 0 || br >= level.h || bc >= w) return false;
      const bi = br * w + bc;
      if (level.wall[bi] || boxes.has(bi)) return false;
      boxes.delete(ni);
      boxes.add(bi);
    }
    player = ni;
  }
  for (const b of boxes) if (!level.goals.has(b)) return false;
  return true;
}

function solveLevel(text: string): string {
  const level = parseLevel(text);
  // One deterministic work budget for the whole level (shared across its
  // rooms): 2.5M node expansions.
  const budget = { used: 0, limit: 2500000 };
  const orientations: Array<Room[] | null> = [detectRooms(level, true), detectRooms(level, false)];
  for (const rooms of orientations) {
    if (rooms === null) continue;
    let moves = '';
    let player = level.player;
    let boxes = [...level.boxes];
    let ok = true;
    for (const room of rooms) {
      const ctx = makeCtx(level.w, level.h, room.boxArea, room.playerArea, room.goals, budget);
      const pushes = solveRoom(ctx, room, budget);
      if (pushes === null) {
        ok = false;
        break;
      }
      // Walk through the hallway to this room's entry cell.
      const blocked = new Uint8Array(level.w * level.h);
      for (const b of boxes) blocked[b] = 1;
      const walk = bfsPath(player, room.entry, level.floor, blocked, level.w);
      if (walk === null) {
        ok = false;
        break;
      }
      moves += walk;
      player = room.entry;
      const expanded = expandPushes(ctx, room.boxes, room.entry, pushes);
      if (expanded === null) {
        ok = false;
        break;
      }
      moves += expanded.moves;
      player = expanded.player;
      // Apply this room's pushes to the global box list.
      const roomBoxSet = new Set(room.boxes);
      const rest = boxes.filter((b) => !roomBoxSet.has(b));
      boxes = [...rest, ...expanded.boxes].sort((a, b) => a - b);
    }
    if (ok && replay(level, moves)) return moves;
    // Otherwise try the next orientation / fall through to whole-level.
    budget.used = 0;
  }
  // Fallback: whole-level push search (sum-of-minima heuristic, capped).
  budget.used = 0;
  {
    const ctx = makeCtx(level.w, level.h, level.floor, level.floor, [...level.goals], budget);
    const pushes = pushSearch(ctx, level.boxes, level.player, 'astar', 400000);
    if (pushes !== null) {
      const expanded = expandPushes(ctx, level.boxes, level.player, pushes);
      if (expanded !== null && replay(level, expanded.moves)) return expanded.moves;
    }
    const greedy = pushSearch(ctx, level.boxes, level.player, 'greedy', 400000);
    if (greedy !== null) {
      const expanded = expandPushes(ctx, level.boxes, level.player, greedy);
      if (expanded !== null && replay(level, expanded.moves)) return expanded.moves;
    }
  }
  return '';
}

const solve = (level: string): string => solveLevel(level);

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
