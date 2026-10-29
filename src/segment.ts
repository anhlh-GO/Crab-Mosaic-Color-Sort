// Turns a stained-glass picture into colour classes, pieces and regions.
//
// - Every non-outline pixel is classified to the nearest palette anchor, then each
//   glass pane (a blob bounded by the black lead lines) takes its majority class.
// - Outline pixels join the class of the nearest pane, so lines vanish with the glass.
// - A grid of `cell`-sized squares cuts each class into pieces: one piece = one ant load.
// - Regions are connected same-class groups of pieces; they carry the on-picture counts.

export type RGB = readonly [number, number, number];

export interface Piece {
  cls: number;
  /** Pixel indices (y * w + x) the piece owns. */
  pixels: Uint32Array;
  cx: number;
  cy: number;
  nbrs: number[];
  /** Touches the picture's edge: reachable from the start. */
  border: boolean;
  region: number;
}

export interface Region {
  cls: number;
  pieces: number[];
}

export interface Board {
  w: number;
  h: number;
  pieces: Piece[];
  regions: Region[];
  /** Pieces per class. */
  counts: number[];
  /** Piece of every pixel. */
  pieceOf: Int32Array;
}

// lead is black; the darkest glass (#404040) must still count as glass
const DARK = 50;

/**
 * `panes`: true for flat-coloured glass, where every pane bounded by lead lines
 * takes its majority colour. False for painted art whose panes shade from one
 * colour into another: each pixel keeps its own colour, only specks are dropped.
 */
export function segment(rgba: Uint8ClampedArray, w: number, h: number, anchors: RGB[][], cell: number, panes = true): Board {
  const n = w * h;
  const cls = new Int16Array(n).fill(-1);

  // 1. raw nearest-anchor class
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    if (Math.max(r, g, b) < DARK) continue;
    let best = 1e9;
    for (let k = 0; k < anchors.length; k++) {
      for (const a of anchors[k]) {
        const d = (r - a[0]) ** 2 + (g - a[1]) ** 2 + (b - a[2]) ** 2;
        if (d < best) { best = d; cls[i] = k; }
      }
    }
  }

  // 2. panes: connected non-dark blobs take their majority class (or, per pixel, same-class blobs); specks become outline
  const pane = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const votes = new Int32Array(anchors.length);
  const members: number[] = [];
  for (let s = 0; s < n; s++) {
    if (cls[s] < 0 || pane[s] >= 0) continue;
    votes.fill(0);
    members.length = 0;
    let sp = 0;
    stack[sp++] = s;
    pane[s] = s;
    while (sp) {
      const i = stack[--sp];
      members.push(i);
      votes[cls[i]]++;
      const x = i % w;
      if (x > 0 && cls[i - 1] >= 0 && pane[i - 1] < 0 && (panes || cls[i - 1] === cls[s])) { pane[i - 1] = s; stack[sp++] = i - 1; }
      if (x < w - 1 && cls[i + 1] >= 0 && pane[i + 1] < 0 && (panes || cls[i + 1] === cls[s])) { pane[i + 1] = s; stack[sp++] = i + 1; }
      if (i >= w && cls[i - w] >= 0 && pane[i - w] < 0 && (panes || cls[i - w] === cls[s])) { pane[i - w] = s; stack[sp++] = i - w; }
      if (i < n - w && cls[i + w] >= 0 && pane[i + w] < 0 && (panes || cls[i + w] === cls[s])) { pane[i + w] = s; stack[sp++] = i + w; }
    }
    let major = 0;
    for (let k = 1; k < votes.length; k++) if (votes[k] > votes[major]) major = k;
    const keep = members.length >= (panes ? 40 : 150);
    for (const i of members) cls[i] = keep ? major : -2;
  }

  // 3. outline / speck pixels take the class of the nearest pane (multi-source BFS)
  let qh = 0, qt = 0;
  const queue = new Int32Array(n);
  for (let i = 0; i < n; i++) if (cls[i] >= 0) queue[qt++] = i;
  while (qh < qt) {
    const i = queue[qh++];
    const x = i % w;
    const c = cls[i];
    if (x > 0 && cls[i - 1] < 0) { cls[i - 1] = c; queue[qt++] = i - 1; }
    if (x < w - 1 && cls[i + 1] < 0) { cls[i + 1] = c; queue[qt++] = i + 1; }
    if (i >= w && cls[i - w] < 0) { cls[i - w] = c; queue[qt++] = i - w; }
    if (i < n - w && cls[i + w] < 0) { cls[i + w] = c; queue[qt++] = i + w; }
  }

  // 4. pieces: same class + same shard cell + connected. Cells are a jittered
  //    Voronoi grid so bites look like broken glass, not squares.
  const cols = Math.ceil(w / cell) + 1, rows = Math.ceil(h / cell) + 1;
  const seedX = new Float32Array(cols * rows), seedY = new Float32Array(cols * rows);
  let hash = 12345;
  const rnd = () => ((hash = (hash * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < cols * rows; k++) {
    seedX[k] = ((k % cols) + 0.15 + rnd() * 0.7) * cell;
    seedY[k] = (Math.floor(k / cols) + 0.15 + rnd() * 0.7) * cell;
  }
  const cellId = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i % w, y = (i / w) | 0, gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    let best = 0, bestD = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const cx = gx + dx, cy = gy + dy;
      if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
      const k = cy * cols + cx, d = (seedX[k] - x) ** 2 + (seedY[k] - y) ** 2;
      if (d < bestD) { bestD = d; best = k; }
    }
    cellId[i] = best;
  }
  const cellOf = (i: number) => cellId[i];
  const pid = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  for (let s = 0; s < n; s++) {
    if (pid[s] >= 0) continue;
    const id = sizes.length;
    const c = cls[s], cs = cellOf(s);
    let sp = 0, size = 0;
    stack[sp++] = s;
    pid[s] = id;
    while (sp) {
      const i = stack[--sp];
      size++;
      const x = i % w;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1];
      for (const j of nb) {
        if (j < 0 || pid[j] >= 0 || cls[j] !== c || cellOf(j) !== cs) continue;
        pid[j] = id;
        stack[sp++] = j;
      }
    }
    sizes.push(size);
  }

  // 5. slivers merge into the biggest same-class neighbour piece
  const minSize = cell * cell * 0.3;
  const remap = sizes.map((_, k) => k);
  const find = (k: number): number => (remap[k] === k ? k : (remap[k] = find(remap[k])));
  const sliverNbrs = new Map<number, Map<number, number>>();
  for (let i = 0; i < n; i++) {
    const a = pid[i];
    if (sizes[a] >= minSize) continue;
    const x = i % w;
    for (const j of [x < w - 1 ? i + 1 : -1, i < n - w ? i + w : -1, x > 0 ? i - 1 : -1, i >= w ? i - w : -1]) {
      if (j < 0 || pid[j] === a || cls[j] !== cls[i]) continue;
      let m = sliverNbrs.get(a);
      if (!m) sliverNbrs.set(a, (m = new Map()));
      m.set(pid[j], (m.get(pid[j]) ?? 0) + 1);
    }
  }
  for (const [a, m] of sliverNbrs) {
    let best = -1, bestSize = -1;
    for (const b of m.keys()) if (sizes[find(b)] > bestSize) { bestSize = sizes[find(b)]; best = find(b); }
    if (best >= 0 && best !== find(a)) { sizes[best] += sizes[find(a)]; remap[find(a)] = best; }
  }
  // drop leftover crumbs (no same-class neighbour) into any neighbour class? keep them: they are real glass
  const finalId = new Map<number, number>();
  const pieceOf = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const root = find(pid[i]);
    let f = finalId.get(root);
    if (f === undefined) finalId.set(root, (f = finalId.size));
    pieceOf[i] = f;
  }

  const count = finalId.size;
  const pcls = new Int16Array(count);
  const psize = new Int32Array(count);
  const sx = new Float64Array(count), sy = new Float64Array(count);
  const border = new Uint8Array(count);
  const nbrSets: Set<number>[] = Array.from({ length: count }, () => new Set());
  for (let i = 0; i < n; i++) {
    const p = pieceOf[i];
    const x = i % w, y = (i / w) | 0;
    pcls[p] = cls[i];
    psize[p]++;
    sx[p] += x;
    sy[p] += y;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border[p] = 1;
    if (x < w - 1 && pieceOf[i + 1] !== p) { nbrSets[p].add(pieceOf[i + 1]); nbrSets[pieceOf[i + 1]].add(p); }
    if (y < h - 1 && pieceOf[i + w] !== p) { nbrSets[p].add(pieceOf[i + w]); nbrSets[pieceOf[i + w]].add(p); }
  }
  const pix = Array.from({ length: count }, (_, p) => new Uint32Array(psize[p]));
  const fill = new Int32Array(count);
  for (let i = 0; i < n; i++) pix[pieceOf[i]][fill[pieceOf[i]]++] = i;

  const pieces: Piece[] = [];
  for (let p = 0; p < count; p++) {
    pieces.push({
      cls: pcls[p], pixels: pix[p], cx: sx[p] / psize[p], cy: sy[p] / psize[p],
      nbrs: [...nbrSets[p]], border: border[p] === 1, region: -1,
    });
  }

  // 6. regions
  const regions: Region[] = [];
  for (let s = 0; s < count; s++) {
    if (pieces[s].region >= 0) continue;
    const r: Region = { cls: pieces[s].cls, pieces: [] };
    const id = regions.length;
    regions.push(r);
    const st = [s];
    pieces[s].region = id;
    while (st.length) {
      const p = st.pop()!;
      r.pieces.push(p);
      for (const q of pieces[p].nbrs) {
        if (pieces[q].region < 0 && pieces[q].cls === r.cls) { pieces[q].region = id; st.push(q); }
      }
    }
  }

  const counts = new Array(anchors.length).fill(0);
  for (const p of pieces) counts[p.cls]++;
  return { w, h, pieces, regions, counts, pieceOf };
}
