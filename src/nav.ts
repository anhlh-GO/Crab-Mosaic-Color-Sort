// Where crabs may walk: a coarse grid over the picture plus a one-cell ring
// around it (the frame). Ring cells are always walkable; a picture cell becomes
// walkable once the piece under it is bitten away. Crabs never cross glass.

import type { Board } from './segment';

/** Picture pixels per nav cell. */
export const NAV = 6;

export interface Route {
  piece: number;
  /** Grid cells from the start to the cell of the piece that is bitten. */
  cells: number[];
}

export class Nav {
  readonly cols: number;
  readonly rows: number;
  /** Grid width including the ring. */
  readonly gw: number;
  readonly gh: number;
  /** Piece under each grid cell; -1 on the ring. */
  readonly cellPiece: Int32Array;
  readonly pieceCells: number[][];
  walk: Uint8Array;
  private seen: Int32Array;
  private from: Int32Array;
  private queue: Int32Array;
  private dist: Int32Array;
  private stamp = 0;

  constructor(board: Board) {
    this.cols = Math.ceil(board.w / NAV);
    this.rows = Math.ceil(board.h / NAV);
    this.gw = this.cols + 2;
    this.gh = this.rows + 2;
    const size = this.gw * this.gh;
    this.cellPiece = new Int32Array(size).fill(-1);
    this.pieceCells = board.pieces.map(() => []);
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const px = Math.min(board.w - 1, Math.floor((cx + 0.5) * NAV));
        const py = Math.min(board.h - 1, Math.floor((cy + 0.5) * NAV));
        const p = board.pieceOf[py * board.w + px];
        const g = this.cell(cx, cy);
        this.cellPiece[g] = p;
        this.pieceCells[p].push(g);
      }
    }
    // a crumb smaller than a cell still needs a cell to be found by
    // — taken, nearest first, from a neighbour that has cells to spare, so no piece is left without one
    board.pieces.forEach((piece, p) => {
      if (this.pieceCells[p].length) return;
      const px = Math.min(this.cols - 1, Math.floor(piece.cx / NAV)), py = Math.min(this.rows - 1, Math.floor(piece.cy / NAV));
      for (let r = 0; r < Math.max(this.cols, this.rows); r++) {
        let best = -1, bestD = Infinity;
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = px + dx, y = py + dy;
          if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) continue;
          const g = this.cell(x, y), old = this.cellPiece[g];
          if (this.pieceCells[old].length < 2) continue;
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; best = g; }
        }
        if (best < 0) continue;
        const old = this.cellPiece[best];
        this.pieceCells[old] = this.pieceCells[old].filter((c) => c !== best);
        this.cellPiece[best] = p;
        this.pieceCells[p].push(best);
        break;
      }
    });
    this.walk = new Uint8Array(size);
    this.seen = new Int32Array(size);
    this.from = new Int32Array(size);
    this.queue = new Int32Array(size);
    this.dist = new Int32Array(size);
    this.reset();
  }

  /** Grid index of picture cell (cx, cy); -1..cols / -1..rows reach the ring. */
  cell(cx: number, cy: number): number {
    return (cy + 1) * this.gw + (cx + 1);
  }

  reset(): void {
    this.walk.fill(0);
    for (let g = 0; g < this.walk.length; g++) if (this.cellPiece[g] < 0) this.walk[g] = 1;
  }

  /** The piece is gone: its cells open up. */
  clear(piece: number): void {
    for (const g of this.pieceCells[piece]) this.walk[g] = 1;
  }

  /** Breadth-first from `start` over open cells to the nearest piece that `accept`s. */
  nearest(start: number, accept: (piece: number) => boolean): Route | null {
    const { gw, walk, seen, from, queue, cellPiece } = this;
    const s = ++this.stamp;
    let head = 0, tail = 0;
    queue[tail++] = start;
    seen[start] = s;
    from[start] = -1;
    const DX = [1, -1, 0, 0, 1, 1, -1, -1];
    const DY = [0, 0, 1, -1, 1, -1, 1, -1];
    while (head < tail) {
      const u = queue[head++];
      const ux = u % gw;
      for (let k = 0; k < 8; k++) {
        const vx = ux + DX[k];
        if (vx < 0 || vx >= gw) continue;
        const v = u + DX[k] + DY[k] * gw;
        if (v < 0 || v >= walk.length || seen[v] === s) continue;
        if (k >= 4 && (!walk[u + DX[k]] || !walk[u + DY[k] * gw])) continue; // no squeezing past glass corners
        if (!walk[v]) {
          if (k < 4 && accept(cellPiece[v])) {
            const cells = [v];
            for (let c = u; c >= 0; c = from[c]) cells.push(c);
            return { piece: cellPiece[v], cells: cells.reverse() };
          }
          continue;
        }
        seen[v] = s;
        from[v] = u;
        queue[tail++] = v;
      }
    }
    return null;
  }

  /**
   * Shortest walk over open cells from `start` to whichever cell gives the
   * lowest walk + `exitCost(cell)` (null = not an exit). A breadth-first sweep
   * (8 directions, never squeezing past glass corners) — cheap enough to run on
   * every bite. Returns the cells, start first.
   */
  shortest(start: number, exitCost: (cell: number) => number | null): number[] | null {
    const { gw, walk, seen, from, queue } = this;
    const dist = this.dist;
    const s = ++this.stamp;
    let head = 0, tail = 0;
    queue[tail++] = start;
    seen[start] = s;
    from[start] = -1;
    dist[start] = 0;
    let best = Infinity, bestCell = -1;
    const DX = [1, -1, 0, 0, 1, 1, -1, -1];
    const DY = [0, 0, 1, -1, 1, -1, 1, -1];
    while (head < tail) {
      const u = queue[head++];
      const exit = exitCost(u);
      if (exit !== null && dist[u] + exit < best) { best = dist[u] + exit; bestCell = u; }
      const ux = u % gw;
      for (let k = 0; k < 8; k++) {
        const vx = ux + DX[k];
        if (vx < 0 || vx >= gw) continue;
        const v = u + DX[k] + DY[k] * gw;
        if (v < 0 || v >= walk.length || seen[v] === s || !walk[v]) continue;
        if (k >= 4 && (!walk[u + DX[k]] || !walk[u + DY[k] * gw])) continue;
        seen[v] = s;
        from[v] = u;
        dist[v] = dist[u] + 1;
        queue[tail++] = v;
      }
    }
    if (bestCell < 0) return null;
    const cells: number[] = [];
    for (let c = bestCell; c >= 0; c = from[c]) cells.push(c);
    return cells.reverse();
  }

  /** Every piece on the edge of the open area, grouped by nothing: callers filter. */
  frontier(start: number): Set<number> {
    const out = new Set<number>();
    this.nearest(start, (p) => { out.add(p); return false; });
    return out;
  }

  /** True when the straight line between two cells crosses only open cells. */
  clearLine(a: number, b: number): boolean {
    const gw = this.gw;
    const ax = (a % gw) + 0.5, ay = Math.floor(a / gw) + 0.5, bx = (b % gw) + 0.5, by = Math.floor(b / gw) + 0.5;
    const steps = Math.ceil(Math.hypot(bx - ax, by - ay) * 3);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
      // check a little either side so crabs keep off the glass
      for (const [ox, oy] of [[0, 0], [0.3, 0.3], [-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3]]) {
        if (!this.walk[Math.floor(y + oy) * gw + Math.floor(x + ox)]) return false;
      }
    }
    return true;
  }

  /** Drops in-between cells a crab can walk past in a straight line. */
  smooth(cells: number[]): number[] {
    if (cells.length < 3) return cells;
    const last = cells.length - 1; // the bitten cell is glass; keep the approach to it
    const out = [cells[0]];
    let i = 0;
    while (i < last - 1) {
      let j = i + 1;
      while (j + 1 < last && this.clearLine(cells[i], cells[j + 1])) j++;
      out.push(cells[j]);
      i = j;
    }
    out.push(cells[last]);
    return out;
  }
}
