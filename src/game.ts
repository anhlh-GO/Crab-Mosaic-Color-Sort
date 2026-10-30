// Jigsaw Hunt — crabs nibble a stained-glass picture away, piece by piece.
//
// Tap the front box of a column to send it to a free slot. A slotted box lets
// its crabs out one by one (its number is the crabs still inside). A crab walks
// up onto the frame and, over the frame and the already-eaten area only (never
// across glass), to the NEAREST piece of its colour it can reach. It bites the
// piece off and carries it back out and down the hole. A box with nothing
// reachable waits; once its last crab is out it frees the slot. Clear the
// picture to win; fill every slot with boxes whose crabs can reach nothing and
// the round is lost.
//
// Boosters (Add Slot, Magic Wand, Magnet) do their work here; at publish the
// studio layer owns their bar, counts and purchases and calls `game.boosters`.
// In development a stand-in bar is drawn so they can be tried.
//
// Keep the `FalconGame` contract at the bottom true — it is how the studio
// layer (and Falcon IDE) drives the game.

import { createFalconEvents, type FalconBoosterDef, type FalconGame } from './falcon-game';
import { segment, type Board } from './segment';
import { Nav, NAV } from './nav';
import { LEVELS, dealTiles } from './levels';
import { PIC_W, PIC_H, loadPictures } from './pictures';
import FalconSDK from '@falcongames/game-client-sdk';
import bgUrl from './assets/bg.jpg';
import winUrl from './assets/ui/popup_win.webp';
import loseUrl from './assets/ui/popup_lose.webp';
import iconAddUrl from './assets/ui/booster_addslot.webp';
import iconHandUrl from './assets/ui/booster_magichand.webp';
import iconHammerUrl from './assets/ui/booster_vacuum.webp';
import btnNextUrl from './assets/ui/btn_next.webp';
import btnAdUrl from './assets/ui/btn_ad.webp';
import btnGemsUrl from './assets/ui/btn_gems.webp';
import btnCloseUrl from './assets/ui/btn_close.webp';
import fxCardsUrl from './assets/ui/fx_addslot.webp';
import fxHandUrl from './assets/ui/fx_magichand.webp';
import fxHammerUrl from './assets/ui/fx_vacuum.webp';

export const LEVEL_COUNT = LEVELS.length;

/**
 * The game draws its own booster bar and win/lose card in development and in
 * the standalone web/APK builds (VITE_STANDALONE=1). A Falcon publish leaves the
 * flag unset: there the studio layer provides both.
 */
const OWN_UI = import.meta.env.DEV || import.meta.env.VITE_STANDALONE === '1';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const events = createFalconEvents();

// ---- layout (design units, 540 wide) ----
const DW = 540;
const PIC_S = 450 / PIC_W;
const PIC_X = (DW - PIC_W * PIC_S) / 2;
const PIC_Y = 108;
const PW = PIC_W * PIC_S;
const PH = PIC_H * PIC_S;
const EDGE = 7; // crabs walk this far outside the picture, on the frame
const HOLE_X = DW / 2;
const HOLE_Y = 604;
const SLOT_Y = 670;
const SLOT_SIZE = 56;
const SLOT_PITCH = 64;
const COL_Y0 = 758;
const COL_PITCH = 74;
const COL_SPACING = 96;
const TILE_SIZE = 60;
const FLY_TIME = 0.24;
const FONT = "'Baloo 2', 'Arial Rounded MT Bold', 'Trebuchet MS', system-ui, sans-serif";

// ---- feel (tuned to the reference video) ----
const CRAB_SPEED = 240;
const CARRY_SPEED = 230;
const RELEASE_EVERY = 0.22;
const MAX_OUT = 14; // crabs of one box on their way to a bite at once
const HOP_TIME = 0.2;
const BITE_TIME = 0.16;
const DROP_TIME = 0.22;
const STEP = 7; // a crab leaves prints in the sand every STEP units
const PRINT_LIFE = 1.4;

// ---- level change: a wave rolls up over the screen, then back down ----
// ---- boosters ----
const BAR_H = 100; // room kept at the bottom for the booster bar
type BoosterKey = 'addslot' | 'magichand' | 'vacuum';
const BOOSTERS: (FalconBoosterDef & { key: BoosterKey })[] = [
  { key: 'addslot', title: 'Add Slot', desc: 'Add an extra slot to the queue', price: 1200, qty: 3, unlock: 5 },
  { key: 'magichand', title: 'Magic Hand', desc: 'Pick any box from the grid', price: 1500, qty: 3, unlock: 8 },
  { key: 'vacuum', title: 'Hammer', desc: 'Smash all pieces of a color', price: 2100, qty: 3, unlock: 11 },
];
const MAX_SLOTS = 7;

const WAVE_IN = 0.9;
const WAVE_HOLD = 0.3;
const WAVE_OUT = 1.15;

// ---- assets ----
const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(img);
    img.src = src;
  });
let bgImg: HTMLImageElement | null = null;
/** Art for the game's own UI (win / slots-full popups, booster buttons). */
type UiArt = 'win' | 'lose' | BoosterKey | 'next' | 'ad' | 'gems' | 'close' | 'cards' | 'hand' | 'hammer';
const ui: Record<UiArt, HTMLImageElement | null> = {
  win: null, lose: null, addslot: null, magichand: null, vacuum: null,
  next: null, ad: null, gems: null, close: null, cards: null, hand: null, hammer: null,
};
const uiLoads = Promise.all(([
  ['win', winUrl], ['lose', loseUrl], ['addslot', iconAddUrl], ['magichand', iconHandUrl], ['vacuum', iconHammerUrl],
  ['next', btnNextUrl], ['ad', btnAdUrl], ['gems', btnGemsUrl], ['close', btnCloseUrl],
  ['cards', fxCardsUrl], ['hand', fxHandUrl], ['hammer', fxHammerUrl],
] as const)
  .map(([k, url]) => loadImage(url).then((img) => { ui[k] = img; })));
const ready = Promise.all([loadImage(bgUrl), loadPictures(), uiLoads]).then(([bg]) => {
  bgImg = bg;
});

// ---- state ----
interface Pt { x: number; y: number }
interface Tile {
  cls: number;
  /** Crabs still in the box. */
  left: number;
  /** Crabs out and not yet done biting. */
  out: number;
  /** Last release attempt found nothing to reach. */
  blocked: boolean;
  x: number;
  y: number;
  state: 'col' | 'fly' | 'slot';
  fromX: number;
  fromY: number;
  t: number;
  releaseT: number;
  shake: number;
  bounce: number;
}
interface Crab {
  tile: Tile;
  cls: number;
  piece: number;
  state: 'go' | 'bite' | 'carry' | 'drop';
  /** The way in, from the box to the bite; walked back reversed. */
  route: Pt[];
  path: Pt[];
  seg: number;
  x: number;
  y: number;
  ang: number;
  phase: number;
  t: number;
  age: number;
  shard: HTMLCanvasElement | null;
  /** Distance since the last print, and which side printed last. */
  walked: number;
  foot: number;
  /** Own walking speed (× the base speed) and sideways lane offset, so crabs spread out. */
  pace: number;
  lane: number;
}
type Kind = 'confetti' | 'dust' | 'shard' | 'star' | 'ring';
interface Particle {
  kind: Kind; x: number; y: number; vx: number; vy: number; life: number; max: number;
  color: string; size: number; rot: number; vr: number;
}
interface Pop { x: number; y: number; t: number; cls: number }

interface LevelData {
  board: Board;
  original: ImageData;
  nav: Nav;
  columns: { cls: number; value: number }[][];
}
const cache = new Map<number, LevelData>();

const INTACT = 0, TAKEN = 1, EATEN = 2;

let level = 0;
let data: LevelData | null = null;
let colors: string[] = [];
let picCanvas = document.createElement('canvas');
let picCtx = picCanvas.getContext('2d')!;
let picData: ImageData | null = null;
/** Bounding box of picture pixels changed since the last upload; x1 < x0 = clean. */
const picDirty = { x0: PIC_W, y0: PIC_H, x1: -1, y1: -1 };
let pstate = new Uint8Array(0);
let eatenCount = 0;
let regionLeft: number[] = [];
/** Where each pane's count sits, and how much room it has there (picture px); null = recompute. */
let regionSpot: ({ x: number; y: number; r: number } | null)[] = [];
let regionPulse: number[] = [];
let columns: Tile[][] = [];
let slots: (Tile | null)[] = [];
let crabs: Crab[] = [];
let particles: Particle[] = [];
let pops: Pop[] = [];
/**
 * Crab prints live in one layer in world units: each is stamped once and the
 * whole layer fades a little every PRINT_FADE seconds, so a beach full of
 * prints costs one drawImage per frame.
 */
const PRINT_RES = 2; // layer pixels per world unit
const PRINT_BOX = { x: -40, y: 0, w: DW + 80, h: 780 };
const PRINT_FADE = 0.1;
const printLayer = document.createElement('canvas');
printLayer.width = PRINT_BOX.w * PRINT_RES;
printLayer.height = PRINT_BOX.h * PRINT_RES;
const printCtx = printLayer.getContext('2d')!;
printCtx.setTransform(PRINT_RES, 0, 0, PRINT_RES, -PRINT_BOX.x * PRINT_RES, -PRINT_BOX.y * PRINT_RES);
let printFadeT = 0;
/** Seconds the win / lose popup has been up; a revive is waiting on an ad. */
let popupT = 0;
let reviveBusy = false;
/** Pressed buttons (seconds since the press), and tap ripples on screen (CSS px). */
const presses = new Map<string, number>();
let taps: { x: number; y: number; t: number }[] = [];
let lastPopupAction = -1;
/** The finished level's picture, whole, for the win popup. */
let winPic: { level: number; canvas: HTMLCanvasElement } | null = null;
/** A booster waiting for its pick. */
let armed: 'magichand' | 'vacuum' | null = null;
/** Camera: 0..1 toward the hand's zoom-out / the hammer's zoom-in. */
let wandT = 0;
let magT = 0;
/** The glove at work on a picked box. */
let handFx: { tile: Tile; t: number; struck: boolean; sent: boolean } | null = null;
/** A piece the hammer breaks, and when its shards fly. */
interface Burst { piece: number; at: number }
let hammer: { t: number; x: number; y: number; cls: number; bursts: Burst[]; hit: boolean } | null = null;
/** Screen shake, 0..1. */
let shake = 0;
/** A slot the booster adds: its card flies in from the button (t < 0), then the slot pops. */
let slotPops: { i: number; t: number; fromX: number; fromY: number }[] = [];
/** Development stand-in for the studio's booster wallet. */
const devCounts: Record<BoosterKey, number> = { addslot: 3, magichand: 3, vacuum: 3 };
let holePulse = 0;
let trans: { phase: 'in' | 'hold' | 'out'; t: number; next: number } | null = null;
let clock = 0;
let playing = false;
let paused = false;
let speed = 1;
let stuckT = 0;
let winT = -1;
let outcome: 'win' | 'lose' | null = null;
let startToken = 0;

function buildLevel(index: number): LevelData {
  const cached = cache.get(index);
  if (cached) return cached;
  const def = LEVELS[index];
  const c = document.createElement('canvas');
  c.width = PIC_W;
  c.height = PIC_H;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  def.picture.draw(g);
  const original = g.getImageData(0, 0, PIC_W, PIC_H);
  const board = segment(original.data, PIC_W, PIC_H, def.picture.classes.map((k) => k.anchors), def.cell, def.picture.panes !== false);
  const nav = new Nav(board);
  const cols = dealTiles(board, def, nav);

  const out = { board, original, nav, columns: cols };
  cache.set(index, out);
  return out;
}

const slotX = (i: number) => DW / 2 + (i - (slots.length - 1) / 2) * SLOT_PITCH;
const colX = (j: number) => DW / 2 + (j - (columns.length - 1) / 2) * COL_SPACING;

function startLevel(index: number): void {
  const next = Math.max(0, Math.min(LEVEL_COUNT - 1, Math.floor(index)));
  playing = false;
  paused = false;
  outcome = null;
  const token = ++startToken;
  void ready.then(() => {
    if (token !== startToken) return;
    if (data) {
      // a board is showing: the wave washes it away first
      trans = { phase: 'in', t: 0, next };
    } else {
      // first boot: the new board is already under the water
      enterLevel(next);
      trans = { phase: 'hold', t: WAVE_HOLD * 0.4, next };
    }
  });
}

function enterLevel(index: number): void {
  level = index;
  setupLevel();
  playing = true;
  // Fire when the board is READY to play — the studio layer starts the level's clock here.
  events.emit('levelStart', { index: level, difficulty: LEVELS[level].difficulty, levelId: `picture-${level + 1}` });
}

function updateWave(dt: number): void {
  clock += dt;
  if (!trans) return;
  trans.t += dt;
  if (trans.phase === 'in' && trans.t >= WAVE_IN) {
    enterLevel(trans.next);
    trans = { phase: 'hold', t: 0, next: trans.next };
  } else if (trans.phase === 'hold' && trans.t >= WAVE_HOLD) {
    trans = { phase: 'out', t: 0, next: trans.next };
  } else if (trans.phase === 'out' && trans.t >= WAVE_OUT) {
    trans = null;
  }
}

function setupLevel(): void {
  const def = LEVELS[level];
  data = buildLevel(level);
  const { board } = data;
  data.nav.reset();
  colors = def.picture.classes.map((k) => k.color);
  picCanvas = document.createElement('canvas');
  picCanvas.width = PIC_W;
  picCanvas.height = PIC_H;
  picCtx = picCanvas.getContext('2d')!;
  picData = new ImageData(new Uint8ClampedArray(data.original.data), PIC_W, PIC_H);
  markDirty(null);
  pstate = new Uint8Array(board.pieces.length);
  eatenCount = 0;
  regionLeft = board.regions.map((r) => r.pieces.length);
  regionSpot = board.regions.map(() => null);
  regionPulse = board.regions.map(() => 0);
  slots = new Array(def.slots).fill(null);
  columns = data.columns.map((col) => col.map((t) => newTile(t.cls, t.value)));
  columns.forEach((col, j) => col.forEach((t, k) => { t.x = colX(j); t.y = COL_Y0 + k * COL_PITCH; }));
  crabs = [];
  particles = [];
  pops = [];
  clearPrints();
  holePulse = 0;
  stuckT = 0;
  winT = -1;
  armed = null;
  wandT = 0;
  magT = 0;
  handFx = null;
  hammer = null;
  shake = 0;
  slotPops = [];
}

function newTile(cls: number, value: number): Tile {
  return { cls, left: value, out: 0, blocked: false, x: 0, y: 0, state: 'col', fromX: 0, fromY: 0, t: 0, releaseT: 0, shake: 0, bounce: 0 };
}

// ---- effects ----
function emit(kind: Kind, x: number, y: number, color: string, n: number, speed: number, size: number, life: number, up = 0): void {
  for (let k = 0; k < n && particles.length < 700; k++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random() * 0.6);
    particles.push({
      kind, x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - up, life: life * (0.7 + Math.random() * 0.3), max: life,
      color, size: size * (0.6 + Math.random() * 0.6), rot: Math.random() * 6, vr: (Math.random() - 0.5) * 14,
    });
  }
}
const ring = (x: number, y: number, color: string, size: number) =>
  particles.push({ kind: 'ring', x, y, vx: 0, vy: 0, life: 0.4, max: 0.4, color, size, rot: 0, vr: 0 });

// ---- pieces & routes ----
const picPoint = (p: number): Pt => {
  const piece = data!.board.pieces[p];
  return { x: PIC_X + piece.cx * PIC_S, y: PIC_Y + piece.cy * PIC_S };
};

/** Design position of a nav cell; ring cells sit out on the frame. */
function cellPoint(g: number): Pt {
  const nav = data!.nav;
  const gx = (g % nav.gw) - 1, gy = Math.floor(g / nav.gw) - 1;
  let x = PIC_X + (gx + 0.5) * NAV * PIC_S, y = PIC_Y + (gy + 0.5) * NAV * PIC_S;
  if (gx < 0) x = PIC_X - EDGE;
  if (gx >= nav.cols) x = PIC_X + PW + EDGE;
  if (gy < 0) y = PIC_Y - EDGE;
  if (gy >= nav.rows) y = PIC_Y + PH + EDGE;
  return { x, y };
}

function entryCell(tile: Tile): number {
  const nav = data!.nav;
  const cx = Math.round((tile.x - PIC_X) / PIC_S / NAV - 0.5);
  return nav.cell(Math.max(0, Math.min(nav.cols - 1, cx)), nav.rows);
}

function tryRelease(tile: Tile): boolean {
  const { nav, board } = data!;
  const route = nav.nearest(entryCell(tile), (p) => pstate[p] === INTACT && board.pieces[p].cls === tile.cls);
  tile.blocked = !route;
  if (!route) return false;
  pstate[route.piece] = TAKEN;
  const cells = nav.smooth(route.cells);
  const pts = cells.map(cellPoint);
  // stop at the glass edge, not on top of it
  const glass = pts.pop()!;
  const near = pts[pts.length - 1];
  pts.push({ x: near.x + (glass.x - near.x) * 0.55, y: near.y + (glass.y - near.y) * 0.55 });
  const lane = (Math.random() * 2 - 1) * 12;
  const from = { x: tile.x, y: tile.y - 24 };
  // across the sand each crab takes its own curve up to the board
  const mid = { x: (from.x + pts[0].x) / 2 + lane * 1.6, y: (from.y + pts[0].y) / 2 };
  const way = lanePath([from, mid, ...pts], lane);
  crabs.push({
    tile, cls: tile.cls, piece: route.piece, state: 'go', route: way, path: way, seg: 1,
    x: from.x, y: from.y, ang: -Math.PI / 2, phase: Math.random() * 6, t: 0, age: 0, shard: null, walked: 0, foot: 0,
    pace: 0.88 + Math.random() * 0.24, lane,
  });
  return true;
}

/** The glass of piece `p` as a sprite, for the crab to carry. */
function shardOf(p: number): HTMLCanvasElement {
  const { pixels } = data!.board.pieces[p];
  let x0 = PIC_W, y0 = PIC_H, x1 = 0, y1 = 0;
  for (const i of pixels) {
    const x = i % PIC_W, y = (i / PIC_W) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const img = new ImageData(w, h);
  const src = data!.original.data;
  for (const i of pixels) {
    const x = (i % PIC_W) - x0, y = ((i / PIC_W) | 0) - y0, o = (y * w + x) * 4;
    img.data[o] = src[i * 4]; img.data[o + 1] = src[i * 4 + 1]; img.data[o + 2] = src[i * 4 + 2]; img.data[o + 3] = 255;
  }
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c;
}

function bite(c: Crab): void {
  const { board, nav } = data!;
  const p = c.piece;
  const piece = board.pieces[p];
  pstate[p] = EATEN;
  eatenCount++;
  nav.clear(p);
  const r = piece.region;
  regionLeft[r]--;
  regionPulse[r] = 1;
  const at = picPoint(p);
  regionSpot[r] = null;
  if (regionLeft[r] === 0) {
    // a whole pane cleared
    emit('star', at.x, at.y, '#fff6c2', 8, 140, 7, 0.6);
    ring(at.x, at.y, '#ffffff', 34);
  }
  const px = picData!.data;
  for (const i of piece.pixels) px[i * 4 + 3] = 0;
  markDirty(piece.pixels);
  c.shard = shardOf(p);
  emit('shard', c.x, c.y, colors[piece.cls], 5, 90, 4, 0.45, 60);
  emit('star', c.x, c.y, '#ffffff', 1, 20, 5, 0.3);
}

/** Grows the dirty box over `pixels` (null = the whole picture). */
function markDirty(pixels: Uint32Array | null): void {
  if (!pixels) { Object.assign(picDirty, { x0: 0, y0: 0, x1: PIC_W - 1, y1: PIC_H - 1 }); return; }
  for (const i of pixels) {
    const x = i % PIC_W, y = (i / PIC_W) | 0;
    if (x < picDirty.x0) picDirty.x0 = x;
    if (x > picDirty.x1) picDirty.x1 = x;
    if (y < picDirty.y0) picDirty.y0 = y;
    if (y > picDirty.y1) picDirty.y1 = y;
  }
}

// ---- update ----
function update(dt: number): void {
  if (picDirty.x1 >= picDirty.x0 && picData) {
    picCtx.putImageData(picData, 0, 0, picDirty.x0, picDirty.y0, picDirty.x1 - picDirty.x0 + 1, picDirty.y1 - picDirty.y0 + 1);
    Object.assign(picDirty, { x0: PIC_W, y0: PIC_H, x1: -1, y1: -1 });
  }
  if (!data) return;

  columns.forEach((col, j) => col.forEach((t, k) => {
    t.x = colX(j);
    t.y += (COL_Y0 + k * COL_PITCH - t.y) * Math.min(1, dt * 14);
    t.shake = Math.max(0, t.shake - dt);
  }));

  slots.forEach((t, i) => {
    if (!t) return;
    t.bounce = Math.max(0, t.bounce - dt * 5);
    if (t.state === 'fly') {
      t.t = Math.min(1, t.t + dt / FLY_TIME);
      const e = 1 - (1 - t.t) ** 3;
      t.x = t.fromX + (slotX(i) - t.fromX) * e;
      t.y = t.fromY + (SLOT_Y - t.fromY) * e - Math.sin(t.t * Math.PI) * 46;
      if (t.t >= 1) {
        t.state = 'slot';
        t.bounce = 1.4;
        t.releaseT = 0.15;
        ring(t.x, t.y, '#ffffff', 42);
        emit('dust', t.x, t.y + 24, 'rgba(255,240,215,0.9)', 5, 60, 5, 0.4);
      }
      return;
    }
    t.x = slotX(i);
    t.y = SLOT_Y;
    if (!playing) return;
    t.releaseT -= dt;
    if (t.releaseT > 0 || t.left <= 0 || t.out >= MAX_OUT) return;
    t.releaseT = RELEASE_EVERY;
    if (!tryRelease(t)) return;
    t.left--;
    t.out++;
    t.bounce = 1;
    emit('dust', t.x, t.y - 26, 'rgba(255,245,225,0.8)', 2, 30, 3, 0.3);
    if (t.left === 0) {
      // last crab out: the box is done
      slots[i] = null;
      pops.push({ x: t.x, y: t.y, t: 0, cls: t.cls });
      emit('confetti', t.x, t.y, colors[t.cls], 16, 300, 7, 0.8, 180);
      emit('star', t.x, t.y, '#ffffff', 4, 120, 6, 0.5);
      ring(t.x, t.y, colors[t.cls], 50);
    }
  });

  for (let k = crabs.length - 1; k >= 0; k--) if (stepCrab(crabs[k], dt)) crabs.splice(k, 1);

  for (const p of particles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
    if (p.kind === 'dust' || p.kind === 'star') { p.vx *= 1 - dt * 4; p.vy *= 1 - dt * 4; }
    else if (p.kind !== 'ring') p.vy += 900 * dt;
    p.life -= dt;
  }
  particles = particles.filter((p) => p.life > 0);
  for (const p of pops) p.t += dt;
  pops = pops.filter((p) => p.t < 0.32);
  fadePrints(dt);
  holePulse = Math.max(0, holePulse - dt * 5);
  wandT = Math.max(0, Math.min(1, wandT + (armed === 'magichand' || handFx ? dt : -dt) / 0.3));
  magT = Math.max(0, Math.min(1, magT + (armed === 'vacuum' || (hammer && hammer.t < HAM_HIT + 0.35) ? dt : -dt) / 0.3));
  shake = Math.max(0, shake - dt * 3.2);
  updateHand(dt);
  for (const p of slotPops) {
    const was = p.t;
    p.t += dt;
    if (was < 0 && p.t >= 0) {
      // the card lands: the slot pops in
      const x = slotX(p.i);
      ring(x, SLOT_Y, '#ffffff', 40);
      emit('star', x, SLOT_Y, '#fff3a0', 9, 170, 7, 0.5);
      emit('dust', x, SLOT_Y + 24, 'rgba(255,240,215,0.9)', 5, 60, 5, 0.4);
    }
  }
  slotPops = slotPops.filter((p) => p.t < 0.5);
  updateHammer(dt);
  for (let r = 0; r < regionPulse.length; r++) if (regionPulse[r] > 0) regionPulse[r] = Math.max(0, regionPulse[r] - dt * 5);

  if (!playing) return;
  if (eatenCount === data.board.pieces.length && crabs.length === 0 && !hammer) {
    if (winT < 0) {
      winT = 1.1;
      for (let k = 0; k < 70; k++) {
        particles.push({ kind: 'confetti', x: Math.random() * DW, y: -20 - Math.random() * 120, vx: (Math.random() - 0.5) * 80, vy: 100 + Math.random() * 200, life: 1.6, max: 1.6, color: colors[k % colors.length], size: 6 + Math.random() * 5, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 12 });
      }
      emit('star', PIC_X + PW / 2, PIC_Y + PH / 2, '#fff6c2', 16, 300, 10, 0.9);
    }
    winT -= dt;
    if (winT <= 0) finish('win');
    return;
  }
  // lost: every slot holds a box that can reach nothing, and no bite is coming that could open more
  const biting = crabs.some((c) => c.state === 'go' || c.state === 'bite');
  const stuck = !biting && !hammer && slots.every((t) => t && t.state === 'slot' && t.blocked);
  stuckT = stuck ? stuckT + dt : 0;
  if (stuckT > 0.6) finish('lose');
}

/** Moves one crab; true when it is gone down the hole. */
function stepCrab(c: Crab, dt: number): boolean {
  c.t += dt;
  c.age += dt;
  if (c.state === 'bite') {
    c.phase += dt * 40;
    if (c.t < BITE_TIME) return false;
    c.tile.out--;
    c.lane = (Math.random() * 2 - 1) * 12;
    c.path = homePath(c);
    c.seg = 1;
    c.state = 'carry';
    c.t = 0;
    return false;
  }
  if (c.state === 'drop') {
    if (c.t < DROP_TIME) return false;
    holePulse = 1;
    emit('dust', HOLE_X, HOLE_Y - 4, 'rgba(225,200,165,0.9)', 3, 50, 5, 0.5, 20);
    return true;
  }
  const x0 = c.x, y0 = c.y;
  let step = (c.state === 'go' ? CRAB_SPEED : CARRY_SPEED) * c.pace * dt;
  if (c.age < HOP_TIME) step *= 0.6;
  while (step > 0) {
    const target = c.path[c.seg];
    const dx = target.x - c.x, dy = target.y - c.y, dist = Math.hypot(dx, dy);
    if (dist <= step) {
      c.x = target.x;
      c.y = target.y;
      step -= dist;
      if (++c.seg < c.path.length) continue;
      c.t = 0;
      if (c.state === 'go') { c.state = 'bite'; bite(c); } else c.state = 'drop';
      break;
    }
    // a little sway on the way, straightening out near the waypoint
    const a = Math.atan2(dy, dx) + (dist > 14 ? Math.sin(c.age * 5 + c.lane) * 0.22 : 0);
    c.x += Math.cos(a) * step;
    c.y += Math.sin(a) * step;
    break;
  }
  const moved = Math.hypot(c.x - x0, c.y - y0);
  c.phase += moved * 0.38;
  if (moved > 0.01) {
    // turn smoothly toward where it is actually going
    let d = Math.atan2(c.y - y0, c.x - x0) - c.ang;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    c.ang += d * Math.min(1, dt * 14);
  }
  c.walked += Math.hypot(c.x - x0, c.y - y0);
  if (c.walked >= STEP && c.age > HOP_TIME && onSand(c.x, c.y)) {
    c.walked = 0;
    c.foot ^= 1;
    stampPrint(c.x, c.y, c.ang, c.foot);
  }
  return false;
}

/** Crabs may stand anywhere off the picture, and on the picture only where it is eaten. */
function walkable(x: number, y: number): boolean {
  if (x < PIC_X || x >= PIC_X + PW || y < PIC_Y || y >= PIC_Y + PH) return true;
  const nav = data!.nav;
  const cx = Math.floor((x - PIC_X) / PIC_S / NAV), cy = Math.floor((y - PIC_Y) / PIC_S / NAV);
  return nav.walk[nav.cell(Math.min(nav.cols - 1, cx), Math.min(nav.rows - 1, cy))] === 1;
}

/**
 * The shortest way from where the crab stands to the hole, in any direction:
 * over eaten ground and round the frame (never across glass still there), off
 * the bottom edge, then across the sand. Falls back to the way it came.
 */
function homePath(c: Crab): Pt[] {
  const nav = data!.nav;
  const cellSize = NAV * PIC_S;
  const hole = { x: HOLE_X + (Math.random() - 0.5) * 18, y: HOLE_Y };
  const cx = Math.max(-1, Math.min(nav.cols, Math.floor((c.x - PIC_X) / cellSize)));
  const cy = Math.max(-1, Math.min(nav.rows, Math.floor((c.y - PIC_Y) / cellSize)));
  let start = nav.cell(cx, cy);
  if (!nav.walk[start]) {
    // standing on the bitten edge: step to any open cell next to it
    for (const d of [1, -1, nav.gw, -nav.gw, nav.gw + 1, nav.gw - 1, -nav.gw + 1, -nav.gw - 1]) {
      if (nav.walk[start + d]) { start += d; break; }
    }
  }
  const bottom = nav.rows + 1; // grid row of the frame under the picture
  const cells = nav.walk[start]
    ? nav.shortest(start, (g) => {
      if (Math.floor(g / nav.gw) !== bottom) return null;
      const p = cellPoint(g);
      return Math.hypot(p.x - hole.x, p.y - hole.y) / cellSize;
    })
    : null;
  let pts: Pt[];
  if (cells) pts = nav.smooth(cells).map(cellPoint).slice(1);
  else pts = c.route.slice(2).reverse().slice(1);
  const exit = pts[pts.length - 1] ?? { x: c.x, y: c.y };
  return lanePath([
    { x: c.x, y: c.y }, ...pts,
    { x: (exit.x + hole.x) / 2 + c.lane * 1.6, y: (exit.y + hole.y) / 2 - 4 }, hole,
  ], c.lane);
}

/** Each crab walks its own line: inner waypoints are nudged sideways by `lane` where the ground allows. */
function lanePath(pts: Pt[], lane: number): Pt[] {
  return pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1) return p;
    const a = pts[i - 1], b = pts[i + 1];
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = -(b.y - a.y) / l, ny = (b.x - a.x) / l;
    for (const k of [1, 0.5, 0.25]) {
      const q = { x: p.x + nx * lane * k, y: p.y + ny * lane * k };
      if (walkable(q.x, q.y)) return q;
    }
    return p;
  });
}

/** Sand outside, or eaten ground on the picture, and not over the hole: somewhere prints show. */
function onSand(x: number, y: number): boolean {
  if (x >= PIC_X && x < PIC_X + PW && y >= PIC_Y && y < PIC_Y + PH) return walkable(x, y);
  return ((x - HOLE_X) / 40) ** 2 + ((y - HOLE_Y) / 18) ** 2 > 1;
}

function finish(result: 'win' | 'lose'): void {
  playing = false;
  stuckT = 0;
  outcome = result;
  if (result === 'win') events.emit('win');
  else events.emit('lose', { canRevive: slots.length < 7 });
}

function revive(): boolean {
  if (outcome !== 'lose' || slots.length >= 7) return false;
  slots.push(null);
  outcome = null;
  playing = true;
  return true;
}

// ---- input ----
let view = { scale: 1, ox: 0, dh: 960, ws: 1, wox: 0, woy: 0 };

canvas.addEventListener('pointerdown', (e) => {
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  taps.push({ x: sx, y: sy, t: 0 });
  // UI space (bar, tooltip) and world space (the board, which the wand zooms out)
  const ux = (sx - view.ox) / view.scale, uy = sy / view.scale;
  const x = (sx - view.wox) / view.ws, y = (sy - view.woy) / view.ws;
  if (OWN_UI && outcome && !paused) {
    // Own UI only: in a Falcon publish the studio layer shows the real win/lose popups.
    popupTap(sx, sy);
    return;
  }
  if (!playing || paused || trans || hammer || handFx) return;
  if (OWN_UI && devBoosterTap(ux, uy)) return;
  if (armed === 'magichand') {
    // any box in any row
    for (let j = 0; j < columns.length; j++) {
      for (let k = 0; k < columns[j].length; k++) {
        const t = columns[j][k];
        if (Math.abs(x - t.x) > TILE_SIZE / 2 + 4 || Math.abs(y - t.y) > TILE_SIZE / 2 + 4) continue;
        if (slots.indexOf(null) < 0) { t.shake = 0.35; return; }
        // the glove comes down on it; the box leaves once it has been lifted
        armed = null;
        handFx = { tile: t, t: 0, struck: false, sent: false };
        spendDev('magichand');
        return;
      }
    }
    return;
  }
  if (armed === 'vacuum') {
    if (x >= PIC_X && x < PIC_X + PW && y >= PIC_Y && y < PIC_Y + PH) {
      const px = Math.min(PIC_W - 1, Math.floor((x - PIC_X) / PIC_S)), py = Math.min(PIC_H - 1, Math.floor((y - PIC_Y) / PIC_S));
      const cls = data!.board.pieces[data!.board.pieceOf[py * PIC_W + px]].cls;
      if (useHammer(cls, x, y)) { armed = null; spendDev('vacuum'); }
    }
    return;
  }
  for (let j = 0; j < columns.length; j++) {
    const t = columns[j][0];
    if (!t || Math.abs(x - t.x) > TILE_SIZE / 2 + 8 || Math.abs(y - t.y) > TILE_SIZE / 2 + 10) continue;
    sendToSlot(j, 0);
    return;
  }
});

/** Box `k` of column `j` flies to the first free slot; shakes when there is none. */
function sendToSlot(j: number, k: number): boolean {
  const t = columns[j][k];
  const free = slots.indexOf(null);
  if (free < 0) { t.shake = 0.35; return false; }
  columns[j].splice(k, 1);
  t.state = 'fly';
  t.fromX = t.x;
  t.fromY = t.y;
  t.t = 0;
  slots[free] = t;
  return true;
}

// ---- boosters ----
function activateBooster(key: string): boolean {
  if (!data || !playing || paused || trans || hammer || handFx) return false;
  if (key === 'addslot') {
    if (slots.length >= MAX_SLOTS) return false;
    slots.push(null);
    // from the Add Slot button (UI space) to world space
    const sx = view.ox + barX(0) * view.scale, sy = barY() * view.scale;
    slotPops.push({ i: slots.length - 1, t: -ADD_FLY, fromX: (sx - view.wox) / view.ws, fromY: (sy - view.woy) / view.ws });
    return true;
  }
  if (key === 'magichand') {
    if (!columns.some((c) => c.length > 0)) return false;
    armed = 'magichand';
    return true;
  }
  if (key === 'vacuum') {
    armed = 'vacuum';
    return true;
  }
  return false;
}

const ADD_FLY = 0.5;

// hammer timeline (seconds): pops up raised, winds back, smashes, recoils, fades
const HAM_POP = 0.22;
const HAM_WIND = 0.46;
const HAM_HIT = 0.6;
const HAM_END = 1.15;

/**
 * The hammer comes down where the player tapped: every piece of colour `cls`
 * breaks (rippling out from the hit) and the boxes of that colour go with it —
 * their crabs have nothing left to eat. The outcome is decided now; the pieces
 * stay on the glass until the blow lands. False when the colour is gone.
 */
function useHammer(cls: number, x: number, y: number): boolean {
  const { board, nav } = data!;
  const bursts: Burst[] = [];
  board.pieces.forEach((piece, p) => {
    if (pstate[p] !== INTACT || piece.cls !== cls) return;
    pstate[p] = EATEN;
    eatenCount++;
    nav.clear(p);
    const at = picPoint(p);
    bursts.push({ piece: p, at: HAM_HIT + Math.min(0.45, Math.hypot(at.x - x, at.y - y) / 900) });
  });
  if (!bursts.length) return false;
  bursts.sort((a, b) => a.at - b.at);
  hammer = { t: 0, x, y, cls, bursts, hit: false };
  return true;
}

function updateHammer(dt: number): void {
  if (!hammer) return;
  const h = hammer;
  h.t += dt;
  if (!h.hit && h.t >= HAM_HIT) {
    h.hit = true;
    shake = 1;
    ring(h.x, h.y, '#ffffff', 46);
    ring(h.x, h.y, colors[h.cls], 70);
    emit('star', h.x, h.y, '#fff3a0', 12, 260, 9, 0.55);
    emit('dust', h.x, h.y, 'rgba(255,250,235,0.9)', 8, 120, 7, 0.5);
    // the boxes of that colour are done for
    columns = columns.map((col) => col.filter((t) => t.cls !== h.cls));
    slots.forEach((t, i) => {
      if (!t || t.cls !== h.cls) return;
      t.left = 0;
      slots[i] = null;
      pops.push({ x: t.x, y: t.y, t: 0, cls: t.cls });
      emit('confetti', t.x, t.y, colors[t.cls], 12, 260, 6, 0.7, 160);
    });
  }
  const px = picData!.data;
  while (h.bursts.length && h.bursts[0].at <= h.t) {
    const { piece: p } = h.bursts.shift()!;
    const piece = data!.board.pieces[p];
    for (const i of piece.pixels) px[i * 4 + 3] = 0;
    markDirty(piece.pixels);
    const r = piece.region;
    regionLeft[r]--;
    regionSpot[r] = null;
    regionPulse[r] = 1;
    // shards fly away from the blow
    const at = picPoint(p);
    const dx = at.x - h.x, dy = at.y - h.y, d = Math.hypot(dx, dy) || 1;
    for (let k = 0; k < 2; k++) {
      const v = 120 + Math.random() * 160, a = Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.9;
      particles.push({
        kind: 'shard', x: at.x, y: at.y, vx: Math.cos(a) * v * (d < 6 ? 0.5 : 1), vy: Math.sin(a) * v - 170,
        life: 0.75, max: 0.75, color: colors[h.cls], size: 4 + Math.random() * 3, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 16,
      });
    }
  }
  if (h.t >= HAM_END && !h.bursts.length) hammer = null;
}

// glove timeline (seconds): drops in, presses the box, lifts it, lets go and waves off
const HAND_DOWN = 0.36;
const HAND_PRESS = 0.5;
const HAND_LIFT = 0.74;
const HAND_END = 1.02;
const HAND_LIFT_H = 44;

function updateHand(dt: number): void {
  if (!handFx) return;
  const h = handFx;
  h.t += dt;
  if (!h.struck && h.t >= HAND_DOWN) {
    h.struck = true;
    h.tile.bounce = 1;
    emit('star', h.tile.x, h.tile.y - TILE_SIZE / 2, '#fff3a0', 8, 170, 7, 0.5);
    ring(h.tile.x, h.tile.y, '#fff3a0', 40);
  }
  if (!h.sent && h.t >= HAND_LIFT) {
    h.sent = true;
    for (let j = 0; j < columns.length; j++) {
      const k = columns[j].indexOf(h.tile);
      if (k < 0) continue;
      h.tile.y -= HAND_LIFT_H; // it flies on from where the glove let go
      sendToSlot(j, k);
      break;
    }
  }
  if (h.t >= HAND_END) handFx = null;
}

/** How high the glove has lifted its box (world units). */
function handLift(t: Tile): number {
  if (!handFx || handFx.tile !== t || handFx.sent || handFx.t < HAND_PRESS) return 0;
  return HAND_LIFT_H * easeOut((handFx.t - HAND_PRESS) / (HAND_LIFT - HAND_PRESS));
}

function spendDev(key: BoosterKey): void {
  if (OWN_UI) devCounts[key] = Math.max(0, devCounts[key] - 1);
}

const barX = (i: number) => DW / 2 + (i - 1) * 104;
/** Booster button art: width in design units, and where its "+" badge sits (fractions of the art). */
const ICON_W = 84;
const ICON_BADGE = { x: 0.82, y: 0.82, r: 0.15 };
const barY = () => view.dh - BAR_H / 2 - 4;

/** A button dips, then springs back past its size and settles. */
const press = (id: string) => presses.set(id, 0);
function pressScale(id: string): number {
  const t = presses.get(id);
  return t === undefined ? 1 : 1 - 0.14 * Math.exp(-t * 7) * Math.cos(t * 19);
}

/** Ripples where the screen was touched. */
function drawTaps(dpr: number): void {
  if (!taps.length) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const p of taps) {
    const k = p.t / 0.4;
    ctx.globalAlpha = (1 - k) * 0.9;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3.5 * (1 - k) + 1;
    ctx.beginPath(); ctx.arc(p.x, p.y, 8 + 30 * easeOut(k), 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#fff6c8';
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3, d = 10 + 34 * easeOut(k);
      ctx.beginPath(); ctx.arc(p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, 2.6 * (1 - k), 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

/** Development stand-in for the studio's booster bar: true when the tap was on it. */
function devBoosterTap(ux: number, uy: number): boolean {
  if (armed && Math.hypot(ux - (DW / 2 + 150), uy - 30) < 18) { armed = null; return true; }
  for (let i = 0; i < BOOSTERS.length; i++) {
    if (Math.hypot(ux - barX(i), uy - barY()) > 38) continue;
    const key = BOOSTERS[i].key;
    press('b:' + key);
    if (devCounts[key] === 0 && armed !== key) {
      // out of stock: no wallet here, so the "+" just restocks
      devCounts[key] = 3;
      ring(barX(i), barY(), '#ffffff', 40);
      return true;
    }
    if (armed === key) armed = null;
    else if (activateBooster(key) && key === 'addslot') spendDev('addslot');
    return true;
  }
  return false;
}

// ---- drawing ----
function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt);
  return `rgb(${mix(n >> 16)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
}

const labelWidths = new Map<string, number>();
const labelSprites = new Map<string, HTMLCanvasElement>();
/** Width of a count at 15px. */
function labelWidth(label: string): number {
  let w = labelWidths.get(label);
  if (w === undefined) {
    ctx.font = `800 15px ${FONT}`;
    labelWidths.set(label, (w = ctx.measureText(label).width));
  }
  return w;
}
/** A pane's count at font size `fs`: white with a dark outline and drop. */
function labelSprite(label: string, fs: number): HTMLCanvasElement {
  const key = `${label}|${fs}`;
  let sprite = labelSprites.get(key);
  if (sprite) return sprite;
  if (labelSprites.size > 600) labelSprites.clear();
  const lw = Math.max(2, fs * 0.27);
  const w = (labelWidth(label) * fs) / 15 + lw * 2 + 2, h = fs + lw * 2 + 3;
  sprite = document.createElement('canvas');
  sprite.width = Math.ceil(w * SPRITE_RES);
  sprite.height = Math.ceil(h * SPRITE_RES);
  const g = sprite.getContext('2d')!;
  g.scale(SPRITE_RES, SPRITE_RES);
  g.font = `800 ${fs}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = lw;
  const cx = w / 2, cy = h / 2 - 0.75;
  g.strokeStyle = 'rgba(20,12,6,0.85)';
  g.fillStyle = 'rgba(20,12,6,0.85)';
  g.strokeText(label, cx, cy + 1.5);
  g.fillText(label, cx, cy + 1.5);
  g.strokeText(label, cx, cy);
  g.fillStyle = '#ffffff';
  g.fillText(label, cx, cy);
  labelSprites.set(key, sprite);
  return sprite;
}

/** Pixels per world unit in cached sprites. */
const SPRITE_RES = 2;
const tileSprites = new Map<string, HTMLCanvasElement>();

/** A box, from its cached sprite (painted on first use). */
function drawTile(x: number, y: number, size: number, color: string, label: string, dim: boolean): void {
  size = Math.round(size);
  const key = `${color}|${size}|${label}|${dim ? 1 : 0}`;
  let sprite = tileSprites.get(key);
  const h = size / 2, top = h + 3, bottom = h + size * 0.17 + 6, side = h + 4;
  if (!sprite) {
    if (tileSprites.size > 600) tileSprites.clear();
    sprite = document.createElement('canvas');
    sprite.width = Math.ceil(side * 2 * SPRITE_RES);
    sprite.height = Math.ceil((top + bottom) * SPRITE_RES);
    const g = sprite.getContext('2d')!;
    g.scale(SPRITE_RES, SPRITE_RES);
    paintTile(g, side, top, size, color, label, dim);
    tileSprites.set(key, sprite);
  }
  ctx.drawImage(sprite, x - side, y - top, sprite.width / SPRITE_RES, sprite.height / SPRITE_RES);
}

/** A chunky 3D box: cream rim, deep side, glossy bevelled top, embossed number. */
function paintTile(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string, label: string, dim: boolean): void {
  const base = dim ? shade(color, 0.42) : color;
  const r = size * 0.24, depth = size * 0.17, h = size / 2;
  ctx.fillStyle = 'rgba(95,50,10,0.25)';
  roundRect(ctx, x - h, y - h + depth + 5, size, size, r);
  ctx.fill();
  ctx.fillStyle = dim ? '#fff4e2' : '#fff8ec';
  roundRect(ctx, x - h - 2.5, y - h - 2.5, size + 5, size + depth + 5, r + 2.5);
  ctx.fill();
  const side = ctx.createLinearGradient(0, y, 0, y + h + depth);
  side.addColorStop(0, shade(color, dim ? 0.3 : -0.25));
  side.addColorStop(1, shade(color, dim ? 0 : -0.5));
  ctx.fillStyle = side;
  roundRect(ctx, x - h, y - h + depth, size, size, r);
  ctx.fill();
  const top = ctx.createLinearGradient(0, y - h, 0, y + h);
  top.addColorStop(0, dim ? shade(color, 0.55) : shade(color, 0.22));
  top.addColorStop(0.55, base);
  top.addColorStop(1, dim ? shade(color, 0.32) : shade(color, -0.12));
  ctx.fillStyle = top;
  roundRect(ctx, x - h, y - h, size, size, r);
  ctx.fill();
  // bevel light on the top edge, shade on the bottom edge
  ctx.lineWidth = 2;
  const bevel = ctx.createLinearGradient(0, y - h, 0, y + h);
  bevel.addColorStop(0, 'rgba(255,255,255,0.75)');
  bevel.addColorStop(0.5, 'rgba(255,255,255,0)');
  bevel.addColorStop(1, 'rgba(0,0,0,0.18)');
  ctx.strokeStyle = bevel;
  roundRect(ctx, x - h + 1.5, y - h + 1.5, size - 3, size - 3, r - 1.5);
  ctx.stroke();
  // gloss
  ctx.fillStyle = 'rgba(255,255,255,0.32)';
  ctx.beginPath();
  ctx.ellipse(x - size * 0.16, y - size * 0.3, size * 0.24, size * 0.08, -0.15, 0, Math.PI * 2);
  ctx.fill();
  if (!label) return;
  const fs = Math.round(size * (label.length > 2 ? 0.38 : 0.46));
  ctx.font = `800 ${fs}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = size * 0.12;
  const ink = dim ? shade(color, 0.05) : shade(color, -0.6);
  ctx.strokeStyle = ink;
  ctx.strokeText(label, x, y + 3);
  ctx.fillStyle = ink;
  ctx.fillText(label, x, y + 3);
  ctx.strokeText(label, x, y + 1);
  ctx.fillStyle = dim ? 'rgba(255,255,255,0.9)' : '#ffffff';
  ctx.fillText(label, x, y + 1);
}

/** An empty slot pressed into the sand. */
function drawSlot(x: number, y: number): void {
  const s = SLOT_SIZE, h = s / 2, r = s * 0.24;
  ctx.fillStyle = 'rgba(255,248,235,0.95)';
  roundRect(ctx, x - h - 2, y - h - 2, s + 4, s + 10, r + 2);
  ctx.fill();
  const g = ctx.createLinearGradient(0, y - h, 0, y + h);
  g.addColorStop(0, '#d9bc96');
  g.addColorStop(0.35, '#ecd8bb');
  g.addColorStop(1, '#f7ead6');
  ctx.fillStyle = g;
  roundRect(ctx, x - h, y - h, s, s + 4, r);
  ctx.fill();
  ctx.strokeStyle = 'rgba(150,100,50,0.25)';
  ctx.lineWidth = 2;
  roundRect(ctx, x - h + 1, y - h + 1, s - 2, s + 2, r - 1);
  ctx.stroke();
}

// crabs: shaded body sprites per colour (claws open / shut); legs are animated live
const SPR = 4, SPR_SIZE = 36;
const crabSprites = new Map<string, HTMLCanvasElement[]>();
function crabSprite(color: string, shut: boolean): HTMLCanvasElement {
  let pair = crabSprites.get(color);
  if (!pair) {
    pair = [false, true].map((closed) => {
      const c = document.createElement('canvas');
      c.width = c.height = SPR_SIZE * SPR;
      const g = c.getContext('2d')!;
      g.scale(SPR, SPR);
      g.translate(SPR_SIZE / 2, SPR_SIZE / 2);
      const dark = shade(color, -0.6);
      g.lineCap = 'round';
      // arms
      for (const s of [-1, 1]) {
        g.strokeStyle = dark; g.lineWidth = 2.6;
        g.beginPath(); g.moveTo(s * 4, -2.5); g.quadraticCurveTo(s * 8, -4, s * 7.5, -8.5); g.stroke();
        g.strokeStyle = shade(color, 0.1); g.lineWidth = 1.3;
        g.beginPath(); g.moveTo(s * 4, -2.5); g.quadraticCurveTo(s * 8, -4, s * 7.5, -8.5); g.stroke();
      }
      // pincers
      for (const s of [-1, 1]) {
        g.save();
        g.translate(s * 7.6, -11);
        const pg = g.createRadialGradient(-1, -1.2, 0.3, 0, 0, 4.2);
        pg.addColorStop(0, shade(color, 0.6)); pg.addColorStop(0.45, color); pg.addColorStop(1, shade(color, -0.45));
        g.fillStyle = pg; g.strokeStyle = dark; g.lineWidth = 0.8;
        const open = closed ? 0.12 : 0.55;
        g.beginPath(); g.ellipse(0, 0.6, 3.3, 3.8, 0, 0, Math.PI * 2); g.fill(); g.stroke();
        g.fillStyle = shade(color, -0.55);
        g.beginPath(); g.moveTo(0, -0.4); g.lineTo(-Math.sin(open) * 4 * s, -4.4); g.lineTo(Math.sin(open) * 1.6 * s, -4.4); g.closePath(); g.fill();
        g.restore();
      }
      // body
      const bg = g.createRadialGradient(-2.6, -2.6, 0.5, 0, 0, 9);
      bg.addColorStop(0, shade(color, 0.65)); bg.addColorStop(0.35, shade(color, 0.12)); bg.addColorStop(0.8, color); bg.addColorStop(1, shade(color, -0.5));
      g.fillStyle = bg; g.strokeStyle = dark; g.lineWidth = 0.9;
      g.beginPath(); g.ellipse(0, 0, 8, 6.2, 0, 0, Math.PI * 2); g.fill(); g.stroke();
      // shell ridge and spots
      g.strokeStyle = shade(color, -0.3); g.lineWidth = 0.6;
      g.beginPath(); g.ellipse(0, 1.2, 5.4, 3.6, 0, Math.PI * 1.1, Math.PI * 1.9); g.stroke();
      g.fillStyle = shade(color, 0.35);
      for (const [sx, sy] of [[-3.5, 2.2], [3.4, 2.4], [0, 3.4]]) { g.beginPath(); g.arc(sx, sy, 0.7, 0, Math.PI * 2); g.fill(); }
      g.fillStyle = 'rgba(255,255,255,0.75)';
      g.beginPath(); g.ellipse(-2.9, -2.8, 2.4, 1.2, -0.4, 0, Math.PI * 2); g.fill();
      // eyes on stalks
      for (const s of [-1, 1]) {
        g.strokeStyle = dark; g.lineWidth = 1.2;
        g.beginPath(); g.moveTo(s * 1.8, -4.8); g.lineTo(s * 2.5, -7.6); g.stroke();
        const eg = g.createRadialGradient(s * 2.5 - 0.5, -8.6, 0.2, s * 2.5, -8.2, 2);
        eg.addColorStop(0, '#ffffff'); eg.addColorStop(1, '#d9dde8');
        g.fillStyle = eg; g.strokeStyle = dark; g.lineWidth = 0.5;
        g.beginPath(); g.arc(s * 2.5, -8.2, 1.9, 0, Math.PI * 2); g.fill(); g.stroke();
        g.fillStyle = '#16100e'; g.beginPath(); g.arc(s * 2.5, -8.6, 1, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#ffffff'; g.beginPath(); g.arc(s * 2.5 - 0.35, -9, 0.38, 0, Math.PI * 2); g.fill();
      }
      g.strokeStyle = dark; g.lineWidth = 0.6;
      g.beginPath(); g.arc(0, -4.4, 1.3, 0.2, Math.PI - 0.2); g.stroke();
      return c;
    });
    crabSprites.set(color, pair);
  }
  return pair[shut ? 1 : 0];
}

function drawCrab(c: Crab): void {
  const color = colors[c.cls];
  let k = 1, lift = 0, spin = 0;
  if (c.state === 'drop') { const t = c.t / DROP_TIME; k = 1 - t * 0.85; lift = t * 6; spin = t * 2.5; }
  else if (c.age < HOP_TIME) { const t = c.age / HOP_TIME; k = 0.45 + 0.55 * t; lift = -Math.sin(t * Math.PI) * 10; }
  const bob = c.state === 'bite' ? Math.sin(c.phase) * 0.6 : Math.abs(Math.sin(c.phase)) * -1.2;
  // ground shadow, lit from the top left
  ctx.fillStyle = `rgba(30,15,5,${0.28 * k})`;
  ctx.beginPath();
  ctx.ellipse(c.x + 2, c.y + 4 - lift * 0.2, 9.5 * k, 5 * k, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.translate(c.x, c.y + lift + bob);
  ctx.rotate(c.ang + spin);
  ctx.scale(k, k);
  // legs: three a side, knee joint, alternate gait
  const dark = shade(color, -0.6), light = shade(color, 0.05);
  for (let pass = 0; pass < 2; pass++) {
    ctx.strokeStyle = pass ? light : dark;
    ctx.lineWidth = pass ? 0.9 : 2.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const s of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const sw = Math.sin(c.phase + i * 2.1 + (s > 0 ? Math.PI : 0)) * 1.8;
        const hy = -1 + i * 2.4;
        ctx.moveTo(s * 6, hy);
        ctx.lineTo(s * (10 + sw * 0.4), hy - 2.4 + sw);
        ctx.lineTo(s * (12.5 + sw * 0.3), hy + 2.6 + sw);
      }
    }
    ctx.stroke();
  }
  const shut = c.state === 'bite' ? Math.sin(c.phase) > 0 : false;
  ctx.drawImage(crabSprite(color, shut), -SPR_SIZE / 2, -SPR_SIZE / 2, SPR_SIZE, SPR_SIZE);
  if (c.shard) {
    // the bitten glass, held up in the claws
    const s = c.shard, sc = PIC_S * 0.72;
    const w = Math.min(26, s.width * sc), h = Math.min(26, s.height * sc);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(-w / 2 + 1.5, -14 - h / 2 + 2, w, h * 0.9);
    ctx.drawImage(s, -w / 2, -14 - h / 2, w, h);
  }
  ctx.restore();
}

/**
 * The point of a pane's remaining glass farthest from any edge — its own lead
 * lines and every eaten spot — so the count sits squarely on its colour.
 * A chamfer distance transform over the pane's bounding box.
 */
function labelSpot(region: number): { x: number; y: number; r: number } | null {
  const cached = regionSpot[region];
  if (cached) return cached;
  const { board, original } = data!;
  const src = original.data;
  let x0 = PIC_W, y0 = PIC_H, x1 = -1, y1 = -1;
  for (const p of board.regions[region].pieces) {
    if (pstate[p] === EATEN) continue;
    for (const i of board.pieces[p].pixels) {
      const x = i % PIC_W, y = (i / PIC_W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const w = x1 - x0 + 3, h = y1 - y0 + 3;
  const d = new Int32Array(w * h);
  for (const p of board.regions[region].pieces) {
    if (pstate[p] === EATEN) continue;
    for (const i of board.pieces[p].pixels) {
      // lead pixels count as edge, so the distance is to the glass's own border
      if (Math.max(src[i * 4], src[i * 4 + 1], src[i * 4 + 2]) < 50) continue;
      d[((i / PIC_W | 0) - y0 + 1) * w + (i % PIC_W) - x0 + 1] = 1 << 20;
    }
  }
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const k = y * w + x;
    if (!d[k]) continue;
    d[k] = Math.min(d[k], d[k - 1] + 3, d[k - w] + 3, d[k - w - 1] + 4, d[k - w + 1] + 4);
  }
  let best = -1, bestD = 0;
  for (let y = h - 2; y >= 1; y--) for (let x = w - 2; x >= 1; x--) {
    const k = y * w + x;
    if (!d[k]) continue;
    d[k] = Math.min(d[k], d[k + 1] + 3, d[k + w] + 3, d[k + w + 1] + 4, d[k + w - 1] + 4);
    if (d[k] > bestD) { bestD = d[k]; best = k; }
  }
  if (best < 0) return null;
  const spot = { x: PIC_X + ((best % w) + x0 - 1 + 0.5) * PIC_S, y: PIC_Y + (((best / w) | 0) + y0 - 1 + 0.5) * PIC_S, r: (bestD / 3) * PIC_S };
  return (regionSpot[region] = spot);
}

function drawParticle(p: Particle): void {
  const t = p.life / p.max;
  ctx.globalAlpha = Math.min(1, t * 1.6);
  switch (p.kind) {
    case 'confetti':
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.scale(1, Math.abs(Math.cos(p.rot * 1.3)) + 0.2);
      ctx.fillStyle = p.color; ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
      ctx.restore();
      break;
    case 'shard':
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.moveTo(0, -p.size); ctx.lineTo(p.size * 0.8, p.size * 0.6); ctx.lineTo(-p.size * 0.7, p.size * 0.4); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.beginPath(); ctx.moveTo(0, -p.size); ctx.lineTo(p.size * 0.2, 0); ctx.lineTo(-p.size * 0.3, 0); ctx.closePath(); ctx.fill();
      ctx.restore();
      break;
    case 'dust':
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1.8 - t), 0, Math.PI * 2); ctx.fill();
      break;
    case 'star': {
      const s = p.size * Math.sin(t * Math.PI);
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot * 0.3);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2, r = i % 2 ? s * 0.28 : s;
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath(); ctx.fill();
      ctx.restore();
      break;
    }
    case 'ring':
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 4 * t;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1.2 - t * 0.7), 0, Math.PI * 2); ctx.stroke();
      break;
  }
  ctx.globalAlpha = 1;
}

function draw(): void {
  // 2x is as sharp as the eye tells apart on a phone; 3x would fill 2.25 times the pixels
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawSand(W, H, 0, 0);
  const scale = Math.min(W / DW, H / 900);
  // the wand zooms the scene out so every row of boxes fits above the bar
  const rows = Math.max(1, ...columns.map((c) => c.length));
  const fit = Math.max(0.45, Math.min(1, (H / scale - BAR_H) / (COL_Y0 + (rows - 1) * COL_PITCH + TILE_SIZE / 2 + 12)));
  // the hammer zooms in on the picture and centres it
  const camW = easeInOut(wandT), camM = easeInOut(magT);
  const zin = Math.min(1.17, (DW - 12) / PW);
  const cam = 1 + (fit - 1) * camW + (zin - 1) * camM;
  const oy = camM * ((H / scale) * 0.45 - (PIC_Y + PH / 2) * zin);
  const ws = scale * cam;
  view = { scale, ox: (W - DW * scale) / 2, dh: H / scale, ws, wox: (W - DW * ws) / 2, woy: oy * scale };
  // the title stays put; everything else is in camera space
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * view.ox, 0);

  // title
  ctx.font = `800 40px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 9;
  ctx.strokeStyle = '#3b2412';
  ctx.strokeText(`Lv. ${level + 1}`, DW / 2, 59);
  ctx.fillStyle = '#3b2412';
  ctx.fillText(`Lv. ${level + 1}`, DW / 2, 59);
  ctx.strokeText(`Lv. ${level + 1}`, DW / 2, 56);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`Lv. ${level + 1}`, DW / 2, 56);

  // the hammer's blow shakes the world (not the UI)
  const shx = shake ? Math.sin(clock * 83) * 7 * shake : 0, shy = shake ? Math.cos(clock * 71) * 6 * shake : 0;
  ctx.setTransform(dpr * ws, 0, 0, dpr * ws, dpr * (view.wox + shx), dpr * (view.woy + shy));
  if (!data) { drawWave(W, H, dpr, scale); drawTaps(dpr); return; }

  // the picture lies straight on the beach: eaten spots show the background sand itself
  ctx.drawImage(picCanvas, PIC_X, PIC_Y, PW, PH);
  // prints go on top: on the picture they only ever sit where the glass is already gone
  drawPrints();
  ctx.strokeStyle = 'rgba(255,246,222,0.85)';
  ctx.lineWidth = 3;
  ctx.strokeRect(PIC_X - 1.5, PIC_Y - 1.5, PW + 3, PH + 3);

  // pieces left per pane
  data.board.regions.forEach((_, r) => {
    // small panes (a mosaic tile, a seed) go unnumbered so the picture stays readable
    if (regionLeft[r] <= 0 || data!.board.regions[r].pieces.length < 3) return;
    const at = labelSpot(r);
    if (!at) return;
    // as big as fits in the room round the spot, never past the pane's edge
    const label = String(regionLeft[r]);
    const half = Math.hypot(labelWidth(label) / 2 + 2, 15 * 0.36 + 2);
    const fit = Math.round(Math.min(1, (at.r - 1) / half) * 15 * 2) / 2;
    if (fit < 6) return;
    const sprite = labelSprite(label, fit);
    const k = (1 + regionPulse[r] * 0.25) / SPRITE_RES;
    const w = sprite.width * k, h = sprite.height * k;
    ctx.drawImage(sprite, at.x - w / 2, at.y - h / 2 + 0.75 * k * SPRITE_RES, w, h);
  });

  // the hole: sunken, with a lit lower lip
  const hs = 1 + holePulse * 0.1;
  ctx.fillStyle = 'rgba(255,226,170,0.9)';
  ctx.beginPath();
  ctx.ellipse(HOLE_X, HOLE_Y + 3, 40 * hs, 18 * hs, 0, 0, Math.PI * 2);
  ctx.fill();
  const hg = ctx.createLinearGradient(0, HOLE_Y - 15, 0, HOLE_Y + 15);
  hg.addColorStop(0, '#0f0805');
  hg.addColorStop(0.6, '#2a180c');
  hg.addColorStop(1, '#5a3618');
  ctx.fillStyle = hg;
  ctx.beginPath();
  ctx.ellipse(HOLE_X, HOLE_Y, 36 * hs, 15 * hs, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(120,70,25,0.6)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(HOLE_X, HOLE_Y, 36 * hs, 15 * hs, 0, Math.PI * 1.05, Math.PI * 1.95);
  ctx.stroke();

  // slots and their boxes
  slots.forEach((_, i) => {
    // a slot added by the booster pops in
    const pop = slotPops.find((p) => p.i === i);
    if (!pop) { drawSlot(slotX(i), SLOT_Y); return; }
    if (pop.t < 0) return; // its card is still on the way
    const k = Math.min(1, pop.t / 0.35);
    ctx.save();
    ctx.translate(slotX(i), SLOT_Y);
    ctx.scale(k * (1 + Math.sin(k * Math.PI) * 0.25), k * (1 + Math.sin(k * Math.PI) * 0.25));
    drawSlot(0, 0);
    ctx.restore();
  });
  slots.forEach((t) => {
    if (!t || t.state !== 'slot') return;
    ctx.save();
    ctx.translate(t.x, t.y + SLOT_SIZE / 2);
    const b = Math.sin(t.bounce * Math.PI) * 0.5 * Math.min(1, t.bounce);
    ctx.scale(1 + b * 0.12, 1 - b * 0.14);
    drawTile(0, -SLOT_SIZE / 2, SLOT_SIZE, colors[t.cls], String(t.left), false);
    ctx.restore();
  });
  for (const p of pops) {
    const k = p.t / 0.32;
    ctx.save();
    ctx.globalAlpha = 1 - k;
    ctx.translate(p.x, p.y);
    ctx.scale(1 + k * 0.6, 1 + k * 0.6);
    drawTile(0, 0, SLOT_SIZE, colors[p.cls], '', false);
    ctx.restore();
  }

  // columns, back rows first
  const bottom = (H - BAR_H * scale - view.woy) / ws;
  const maxRows = Math.max(1, Math.floor((bottom - COL_Y0 - TILE_SIZE / 2 - 8) / COL_PITCH) + 1);
  const wandOut = armed === 'magichand' || handFx !== null;
  ctx.globalAlpha = 1 - camM;
  columns.forEach((col) => {
    for (let k = Math.min(col.length, maxRows) - 1; k >= 0; k--) {
      const t = col[k];
      const sx = t.shake > 0 ? Math.sin(t.shake * 60) * 5 : 0;
      const picked = handFx?.tile === t;
      const lift = handLift(t);
      if (picked) {
        // the picked box glows, brightest as the glove presses it
        const g = 0.45 + Math.sin(clock * 10) * 0.2 + t.bounce * 0.4;
        ctx.fillStyle = `rgba(255,248,200,${Math.min(1, g)})`;
        roundRect(ctx, t.x - TILE_SIZE / 2 - 5, t.y - lift - TILE_SIZE / 2 - 5, TILE_SIZE + 10, TILE_SIZE + 18, 16);
        ctx.fill();
      }
      // pressed: squash down; lifted: stretch a little
      const b = picked ? Math.sin(t.bounce * Math.PI) * 0.14 : 0;
      ctx.save();
      ctx.translate(t.x + sx, t.y - lift);
      ctx.scale(1 + b, 1 - b + (lift ? 0.04 : 0));
      drawTile(0, 0, TILE_SIZE, colors[t.cls], String(t.left), k > 0 && !wandOut);
      ctx.restore();
    }
  });
  ctx.globalAlpha = 1;

  // flying boxes on top, growing as they lift
  slots.forEach((t) => {
    if (!t || t.state !== 'fly') return;
    const s = SLOT_SIZE + (TILE_SIZE - SLOT_SIZE) * (1 - t.t) + Math.sin(t.t * Math.PI) * 8;
    drawTile(t.x, t.y, s, colors[t.cls], String(t.left), false);
  });

  for (const c of crabs) if (c.state !== 'drop') drawCrab(c);
  for (const c of crabs) if (c.state === 'drop') drawCrab(c);
  drawHammerFx();
  drawHandFx();
  drawAddFx();
  for (const p of particles) drawParticle(p);

  // the bar and its tooltip stay put while the board zooms
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * view.ox, 0);
  if (OWN_UI) drawDevBoosters();
  if (OWN_UI && outcome) drawPopup(W, H, dpr);
  drawWave(W, H, dpr, scale);
  drawTaps(dpr);
}

// ---- sand, prints and the wave ----
let relief: { canvas: HTMLCanvasElement; key: string } | null = null;
/** Sunlight from above and darker corners over the sand, cached per screen size. */
function sandRelief(W: number, H: number): HTMLCanvasElement {
  const key = `${W}x${H}`;
  if (relief?.key === key) return relief.canvas;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(W));
  c.height = Math.max(1, Math.round(H));
  const g = c.getContext('2d')!;
  const sun = g.createRadialGradient(W / 2, H * 0.1, 0, W / 2, H * 0.1, H * 0.7);
  sun.addColorStop(0, 'rgba(255,252,230,0.18)');
  sun.addColorStop(1, 'rgba(255,252,230,0)');
  g.fillStyle = sun;
  g.fillRect(0, 0, W, H);
  const vig = g.createRadialGradient(W / 2, H * 0.42, Math.min(W, H) * 0.4, W / 2, H * 0.5, Math.max(W, H) * 0.78);
  vig.addColorStop(0, 'rgba(130,65,10,0)');
  vig.addColorStop(1, 'rgba(130,65,10,0.26)');
  g.fillStyle = vig;
  g.fillRect(0, 0, W, H);
  relief = { canvas: c, key };
  return c;
}

/** Presses one step's pair of dimples into the print layer. */
function stampPrint(px: number, py: number, ang: number, foot: number): void {
  const side = foot ? 1 : -1;
  const cos = Math.cos(ang), sin = Math.sin(ang);
  for (const k of [-1, 1]) {
    // one dimple each side of the crab, the sides stepping alternately
    const along = side * 1.6 * k, across = 5 * k;
    const x = px + cos * along - sin * across, y = py + sin * along + cos * across;
    printCtx.fillStyle = 'rgba(135,78,25,0.45)';
    printCtx.beginPath(); printCtx.arc(x, y, 1.6, 0, Math.PI * 2); printCtx.fill();
    printCtx.fillStyle = 'rgba(255,240,205,0.6)';
    printCtx.beginPath(); printCtx.arc(x + 0.8, y + 0.9, 1, 0, Math.PI * 2); printCtx.fill();
  }
}

/** Fades the whole layer so a print is gone after about PRINT_LIFE seconds. */
function fadePrints(dt: number): void {
  printFadeT += dt;
  if (printFadeT < PRINT_FADE) return;
  const steps = Math.round(PRINT_LIFE / PRINT_FADE);
  printFadeT = 0;
  printCtx.save();
  printCtx.setTransform(1, 0, 0, 1, 0, 0);
  printCtx.globalCompositeOperation = 'destination-out';
  printCtx.fillStyle = `rgba(0,0,0,${(3 / steps).toFixed(3)})`;
  printCtx.fillRect(0, 0, printLayer.width, printLayer.height);
  printCtx.restore();
}

function clearPrints(): void {
  printCtx.save();
  printCtx.setTransform(1, 0, 0, 1, 0, 0);
  printCtx.clearRect(0, 0, printLayer.width, printLayer.height);
  printCtx.restore();
}

function drawPrints(): void {
  ctx.drawImage(printLayer, PRINT_BOX.x, PRINT_BOX.y, PRINT_BOX.w, PRINT_BOX.h);
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeOutBack = (t: number) => 1 + 2.7 * (t - 1) ** 3 + 1.7 * (t - 1) ** 2;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** How much of the screen the water covers, 0..1: it surges in fast and settles, then drains back smoothly. */
function waveCover(): number {
  if (!trans) return 0;
  if (trans.phase === 'in') return easeOut(Math.min(1, trans.t / WAVE_IN));
  if (trans.phase === 'hold') return 1;
  return 1 - easeInOut(Math.min(1, trans.t / WAVE_OUT));
}

/** Screen y of the wave's crest; below the screen when there is no wave. */
function waveTop(H: number): number {
  return H + 60 - waveCover() * (H + 220);
}

/** The beach itself: background art plus its light, optionally nudged (for the wobble seen through water). */
let beach: { canvas: HTMLCanvasElement; key: string } | null = null;
function drawSand(W: number, H: number, dx: number, dy: number): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const key = `${W}x${H}@${dpr}:${bgImg?.width ?? 0}`;
  if (beach?.key !== key) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(W * dpr));
    c.height = Math.max(1, Math.round(H * dpr));
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    g.fillStyle = '#f7c46c';
    g.fillRect(0, 0, W, H);
    if (bgImg && bgImg.width) {
      const s = Math.max(W / bgImg.width, H / bgImg.height);
      g.drawImage(bgImg, (W - bgImg.width * s) / 2, 0, bgImg.width * s, bgImg.height * s);
    }
    g.drawImage(sandRelief(W, H), 0, 0, W, H);
    beach = { canvas: c, key };
  }
  if (dx || dy) {
    ctx.fillStyle = '#f7c46c';
    ctx.fillRect(0, 0, W, H);
  }
  ctx.drawImage(beach.canvas, dx, dy, W, H);
}

/**
 * Clear shallow sea washing over the beach: under the water is the same sand
 * (gently swaying, as if refracted), tinted turquoise, with caustic light and
 * foam on top. The board under it is hidden, so the level can change unseen.
 */
function drawWave(W: number, H: number, dpr: number, u: number): void {
  if (!trans || waveCover() <= 0) return;
  const top = waveTop(H);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // the crest rolls sideways: three swells of different length and speed
  const edge = (x: number, lag: number, amp: number, sp: number) =>
    top + lag
    + Math.sin(x * 0.009 / u + clock * sp + lag * 0.03) * amp
    + Math.sin(x * 0.023 / u - clock * sp * 1.3 + 1.7) * amp * 0.45
    + Math.sin(x * 0.051 / u + clock * sp * 0.7 + 0.4) * amp * 0.18;
  const trace = (lag: number, amp: number, sp: number) => {
    ctx.beginPath();
    for (let x = -10; x <= W + 10; x += 6) ctx.lineTo(x, edge(x, lag, amp, sp));
  };
  const shape = (lag: number, amp: number, sp: number) => {
    trace(lag, amp, sp);
    ctx.lineTo(W + 10, H + 10);
    ctx.lineTo(-10, H + 10);
    ctx.closePath();
  };

  // draining back, the water leaves lines of foam on the sand
  if (trans.phase === 'out') {
    const k = 1 - Math.min(1, trans.t / WAVE_OUT);
    ctx.lineWidth = 2 * u;
    for (const [lag, al] of [[-34, 0.55], [-72, 0.32]] as const) {
      ctx.strokeStyle = `rgba(255,255,255,${al * k})`;
      ctx.setLineDash([10 * u, 6 * u, 3 * u, 6 * u]);
      trace(lag * u, 10 * u, 0.8);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // a thin film of swash running ahead, just a glint over the sand
  shape(-22 * u, 11 * u, 1.6);
  ctx.fillStyle = 'rgba(200,248,250,0.26)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 2 * u;
  trace(-22 * u, 11 * u, 1.6);
  ctx.stroke();

  // the water: the beach seen through it
  shape(0, 16 * u, 1.2);
  ctx.save();
  ctx.clip();
  drawSand(W, H, Math.sin(clock * 1.7) * 2.5 * u, Math.cos(clock * 1.3) * 2 * u);
  // turn the sand turquoise while keeping its ripples (hue from the sea, light from the sand)
  ctx.globalCompositeOperation = 'color';
  const hue = ctx.createLinearGradient(0, top - 20 * u, 0, top + H);
  hue.addColorStop(0, 'rgba(40,215,225,0.7)');
  hue.addColorStop(0.15, 'rgba(0,190,220,0.9)');
  hue.addColorStop(1, 'rgba(0,130,215,0.95)');
  ctx.fillStyle = hue;
  ctx.fillRect(0, top - 40 * u, W, H - top + 60 * u);
  ctx.globalCompositeOperation = 'source-over';
  // and a little deeper further from the shore
  const tint = ctx.createLinearGradient(0, top - 20 * u, 0, top + H);
  tint.addColorStop(0, 'rgba(160,245,250,0.18)');
  tint.addColorStop(0.12, 'rgba(40,190,235,0.2)');
  tint.addColorStop(1, 'rgba(10,95,190,0.42)');
  ctx.fillStyle = tint;
  ctx.fillRect(0, top - 40 * u, W, H - top + 60 * u);
  // the sunlit surface: a bright sheen just behind the crest
  const sheen = ctx.createLinearGradient(0, top, 0, top + 140 * u);
  sheen.addColorStop(0, 'rgba(255,255,255,0.22)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, top - 20 * u, W, 160 * u);
  // caustics: two sets of bright wavy lines drifting across each other
  ctx.lineWidth = 1.8 * u;
  for (let set = 0; set < 2; set++) {
    ctx.strokeStyle = `rgba(255,255,255,${set ? 0.1 : 0.14})`;
    for (let k = 0; k < 40; k++) {
      const y0 = top + (24 + k * 30 + set * 15) * u;
      if (y0 > H + 20) break;
      ctx.beginPath();
      for (let x = -10; x <= W + 10; x += 10) {
        ctx.lineTo(x, y0 + Math.sin(x * (set ? 0.034 : 0.026) / u + clock * (set ? -1.6 : 1.9) + k * 1.7) * 7 * u
          + Math.sin(x * 0.061 / u + clock * 2.4 + k) * 2.5 * u);
      }
      ctx.stroke();
    }
  }
  ctx.restore();

  // foam riding the crest: a soft band and a bright lip
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 7 * u;
  trace(8 * u, 16 * u, 1.2);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 6 * u;
  trace(0, 16 * u, 1.2);
  ctx.stroke();
  for (let k = 0; k < 60; k++) {
    const drift = ((k % 5) - 2) * 14 * u;
    const x = (((k * 89.7 + clock * drift) % (W + 30)) + W + 30) % (W + 30) - 15;
    const y = edge(x, 0, 16 * u, 1.2) + (3 + ((k * 37) % 18)) * u;
    const r = (1.2 + (k % 4) * 0.9) * u;
    ctx.fillStyle = `rgba(255,255,255,${0.45 + (k % 3) * 0.2})`;
    ctx.beginPath();
    ctx.ellipse(x, y, r * 1.5, r, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Draws `img` centred on (x, y), `w` wide, turned by `rot`, squashed by sx / sy. */
function sprite(img: HTMLImageElement | null, x: number, y: number, w: number, rot = 0, sx = 1, sy = 1): void {
  if (!img) return;
  const h = (img.height / img.width) * w;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(sx, sy);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.restore();
}

// in the hammer art the head points up-left of its handle's end
const HAM_W = 124;
const HAM_PIVOT = { x: 0.32, y: 0.4 }; // handle end, from the art's centre (fractions of its size)
const HAM_HEAD_ANGLE = Math.atan2(-0.42, -0.36); // from the handle end to the head
const HAM_REACH = 0.6; // handle end to head, × width

/** The hammer's angle (head direction from the handle end) and size at time `t`. */
function hammerPose(t: number): { a: number; s: number; alpha: number } {
  const RAISED = -1.05, BACK = -0.6, HIT = Math.PI * 0.82;
  if (t < HAM_POP) return { a: RAISED, s: easeOutBack(t / HAM_POP), alpha: 1 };
  if (t < HAM_WIND) return { a: RAISED + (BACK - RAISED) * easeInOut((t - HAM_POP) / (HAM_WIND - HAM_POP)), s: 1, alpha: 1 };
  // the swing runs the long way round: up, over, down onto the glass
  if (t < HAM_HIT) { const k = (t - HAM_WIND) / (HAM_HIT - HAM_WIND); return { a: BACK - (BACK + Math.PI * 2 - HIT) * k * k, s: 1, alpha: 1 }; }
  const after = t - HAM_HIT;
  const recoil = Math.sin(Math.min(1, after / 0.25) * Math.PI) * 0.35;
  const fade = Math.max(0, (t - (HAM_END - 0.3)) / 0.3);
  return { a: HIT - Math.PI * 2 + recoil + fade * 0.6, s: 1 + fade * 0.2, alpha: 1 - fade };
}

function drawHammerFx(): void {
  if (!hammer || !ui.hammer) return;
  const h = hammer;
  // the handle end sits up and right of the spot, so the head lands on it
  const reach = HAM_W * HAM_REACH;
  const hitA = Math.PI * 0.82;
  const ex = h.x - Math.cos(hitA) * reach, ey = h.y - Math.sin(hitA) * reach;
  const draw = (t: number, alpha: number) => {
    const p = hammerPose(t);
    const rot = p.a - HAM_HEAD_ANGLE;
    // place the art so its handle end is at (ex, ey)
    const w = HAM_W * p.s, hh = (ui.hammer!.height / ui.hammer!.width) * w;
    const ox = HAM_PIVOT.x * w, oy = HAM_PIVOT.y * hh;
    const cx = ex - (Math.cos(rot) * ox - Math.sin(rot) * oy), cy = ey - (Math.sin(rot) * ox + Math.cos(rot) * oy);
    ctx.globalAlpha = alpha * p.alpha;
    sprite(ui.hammer, cx, cy, w, rot);
  };
  // the head's shadow on the glass grows as it comes down
  if (h.t < HAM_HIT) {
    const k = Math.max(0, (h.t - HAM_WIND) / (HAM_HIT - HAM_WIND));
    ctx.fillStyle = `rgba(30,15,5,${0.12 + 0.25 * k})`;
    ctx.beginPath(); ctx.ellipse(h.x, h.y + 4, 22 * (0.5 + k * 0.5), 9 * (0.5 + k * 0.5), 0, 0, Math.PI * 2); ctx.fill();
  }
  // motion trail on the downswing
  if (h.t > HAM_WIND && h.t < HAM_HIT + 0.05) {
    for (const [lag, a] of [[0.05, 0.25], [0.025, 0.4]] as const) draw(Math.max(HAM_WIND, h.t - lag), a);
  }
  draw(h.t, 1);
  ctx.globalAlpha = 1;
}

/** The glove drops onto the picked box fingers first, presses, lifts it, then waves off. */
function drawHandFx(): void {
  if (!handFx || !ui.hand) return;
  const { t, tile } = handFx;
  const W = 78;
  // the art's fingers point up-left: turned so they point down at the box
  const ROT = Math.PI * 1.18;
  const tipY = tile.y - TILE_SIZE / 2 + 8; // where the fingertips touch
  const rest = tipY - W * 0.42; // glove centre when touching
  let y = rest - 70, sx = 1, sy = 1, alpha = 1, rot = ROT, x = tile.x + 6;
  if (t < 0.2) { const k = t / 0.2; y = rest - 110 + 40 * k; sx = sy = easeOutBack(k); alpha = Math.min(1, k * 2); }
  else if (t < HAND_DOWN) { const k = (t - 0.2) / (HAND_DOWN - 0.2); y = rest - 70 + 70 * k * k; }
  else if (t < HAND_PRESS) { const k = (t - HAND_DOWN) / (HAND_PRESS - HAND_DOWN); y = rest + 4 * Math.sin(k * Math.PI); sx = 1 + 0.1 * Math.sin(k * Math.PI); sy = 1 - 0.12 * Math.sin(k * Math.PI); }
  else if (t < HAND_LIFT) { y = rest - handLift(tile); rot = ROT + 0.06 * Math.sin((t - HAND_PRESS) * 20); }
  else { const k = (t - HAND_LIFT) / (HAND_END - HAND_LIFT); y = rest - HAND_LIFT_H - 120 * k * k; x += 40 * k; rot = ROT - 0.5 * k; alpha = 1 - k; }
  // its shadow on the box gets darker as it comes close
  if (t < HAND_PRESS) {
    const near = Math.max(0, 1 - (tipY - (y + W * 0.42)) / 80);
    ctx.fillStyle = `rgba(40,20,5,${0.25 * near})`;
    ctx.beginPath(); ctx.ellipse(tile.x, tipY + 4, 20, 7, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = alpha;
  sprite(ui.hand, x, y, W, rot, sx, sy);
  ctx.globalAlpha = 1;
}

/** The Add Slot card on its way from the button to the new slot. */
function drawAddFx(): void {
  for (const p of slotPops) {
    if (p.t >= 0) continue;
    const k = 1 + p.t / ADD_FLY;
    const e = easeInOut(k);
    const x = p.fromX + (slotX(p.i) - p.fromX) * e, y = p.fromY + (SLOT_Y - p.fromY) * e - Math.sin(k * Math.PI) * 90;
    const w = 54 * (0.7 + Math.sin(k * Math.PI) * 0.5);
    sprite(ui.cards, x, y, w, (1 - k) * Math.PI * 1.5);
  }
}

/** Development stand-in for the studio's booster bar and its tooltip. */
function drawDevBoosters(): void {
  const y = barY();
  BOOSTERS.forEach((b, i) => {
    const x = barX(i);
    if (armed === b.key) {
      ctx.fillStyle = `rgba(255,230,90,${0.45 + Math.sin(clock * 8) * 0.25})`;
      ctx.beginPath(); ctx.arc(x, y, 42, 0, Math.PI * 2); ctx.fill();
    }
    const img = ui[b.key];
    if (!img) return;
    // the art comes with a green "+" badge: shown as is when out of stock,
    // otherwise covered by the count
    const k = pressScale('b:' + b.key) * (armed === b.key ? 1 + 0.06 * Math.sin(clock * 7) : 1);
    const w = ICON_W, h = (img.height / img.width) * w;
    ctx.fillStyle = 'rgba(100,55,10,0.28)';
    ctx.beginPath(); ctx.ellipse(x + 2, y + h * 0.42, w * 0.4 * k, h * 0.1, 0, 0, Math.PI * 2); ctx.fill();
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(k, k);
    ctx.translate(-x, -y);
    ctx.drawImage(img, x - w / 2, y - h / 2, w, h);
    const n = devCounts[b.key];
    if (n > 0) {
      const bx = x - w / 2 + ICON_BADGE.x * w, by = y - h / 2 + ICON_BADGE.y * h, r = ICON_BADGE.r * w;
      ctx.fillStyle = '#fff6e6';
      ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#e8352b';
      ctx.beginPath(); ctx.arc(bx, by, r - 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = `800 ${Math.round(r * 1.25)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(n), bx, by + 1);
    }
    ctx.restore();
  });
  if (!armed) return;
  const b = BOOSTERS.find((d) => d.key === armed)!;
  // the tooltip slides down from above
  const tip = Math.min(1, (armed === 'magichand' ? wandT : magT) * 1.5);
  ctx.save();
  ctx.translate(0, (1 - easeOutBack(tip)) * -90);
  ctx.fillStyle = 'rgba(30,60,120,0.25)';
  roundRect(ctx, DW / 2 - 150, 26, 300, 62, 16); ctx.fill();
  ctx.fillStyle = '#fffaf0';
  roundRect(ctx, DW / 2 - 150, 22, 300, 62, 16); ctx.fill();
  ctx.strokeStyle = '#2f6fe4'; ctx.lineWidth = 3; ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#173a7a';
  ctx.font = `800 22px ${FONT}`;
  ctx.fillText(b.title, DW / 2, 42);
  ctx.fillStyle = '#3d5d9a';
  ctx.font = `700 15px ${FONT}`;
  ctx.fillText(b.desc, DW / 2, 66);
  ctx.fillStyle = '#e8352b';
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(DW / 2 + 150, 30, 15, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3.5; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(DW / 2 + 144, 24); ctx.lineTo(DW / 2 + 156, 36); ctx.moveTo(DW / 2 + 156, 24); ctx.lineTo(DW / 2 + 144, 36); ctx.stroke();
  ctx.restore();
}

// ---- the game's own popups (dev and standalone builds) ----
// Layouts are in the art's own pixel space (the files are drawn at these sizes):
// the win art is 1024×1536, the slots-full panel 975×1025.
const WIN = { w: 1024, h: 1536, box: [90, 20, 934, 1420], quad: [272, 425, 750, 425, 772, 884, 252, 884], next: [252, 1256, 771, 1412] };
const LOSE = { w: 975, h: 1025, ad: [71, 771, 525, 949], gems: [541, 782, 920, 972], close: [824, 61, 954, 197] };
/** Each popup button: its art, where it sits, when it pops in, and whether it breathes to invite a tap. */
const POPUP_BUTTONS: Record<'win' | 'lose', { id: 'next' | 'ad' | 'gems' | 'close'; box: number[]; delay: number; breathe: boolean }[]> = {
  win: [{ id: 'next', box: WIN.next, delay: 0.32, breathe: true }],
  lose: [
    { id: 'ad', box: LOSE.ad, delay: 0.26, breathe: true },
    { id: 'gems', box: LOSE.gems, delay: 0.34, breathe: false },
    { id: 'close', box: LOSE.close, delay: 0.42, breathe: false },
  ],
};

function drawPopupButtons(L: { s: number; x: number; y: number }): void {
  for (const b of POPUP_BUTTONS[outcome === 'win' ? 'win' : 'lose']) {
    const img = ui[b.id];
    if (!img) continue;
    const [x0, y0, x1, y1] = b.box;
    const enter = easeOutBack(Math.max(0, Math.min(1, (popupT - b.delay) / 0.3)));
    if (enter <= 0) continue;
    const k = enter * pressScale('p:' + b.id) * (b.breathe ? 1 + 0.035 * Math.sin(popupT * 5) : 1);
    const cx = L.x + ((x0 + x1) / 2) * L.s, cy = L.y + ((y0 + y1) / 2) * L.s;
    const w = (x1 - x0 + 1) * L.s * k, h = (y1 - y0 + 1) * L.s * k;
    ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
  }
}

const popupPop = () => easeOutBack(Math.min(1, popupT / 0.35));

/** Where the art sits on screen (CSS px): its scale and top-left, at full size. */
function popupLayout(W: number, H: number): { s: number; x: number; y: number } {
  if (outcome === 'win') {
    const [x0, y0, x1, y1] = WIN.box;
    const s = Math.min((W * 0.98) / (x1 - x0), (H * 0.98) / (y1 - y0));
    return { s, x: W / 2 - ((x0 + x1) / 2) * s, y: H / 2 - ((y0 + y1) / 2) * s };
  }
  const s = Math.min((W * 0.94) / LOSE.w, (H * 0.8) / LOSE.h);
  return { s, x: W / 2 - (LOSE.w / 2) * s, y: H * 0.48 - (LOSE.h / 2) * s };
}

function drawPopup(W: number, H: number, dpr: number): void {
  const t = popupPop();
  const L = popupLayout(W, H);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = `rgba(20,12,6,${0.62 * Math.min(1, popupT / 0.25)})`;
  ctx.fillRect(0, 0, W, H);
  // grow from the centre with a little overshoot
  const cx = W / 2, cy = H / 2;
  ctx.translate(cx, cy);
  ctx.scale(t, t);
  ctx.translate(-cx, -cy);
  ctx.globalAlpha = Math.min(1, popupT / 0.15);
  if (outcome === 'win') drawWinArt(L);
  else if (ui.lose) ctx.drawImage(ui.lose, L.x, L.y, LOSE.w * L.s, LOSE.h * L.s);
  drawPopupButtons(L);
  ctx.globalAlpha = 1;
}

function drawWinArt(L: { s: number; x: number; y: number }): void {
  if (!ui.win || !data) return;
  // the finished picture, whole, fills the art's frame window
  if (winPic?.level !== level) {
    const c = document.createElement('canvas');
    c.width = PIC_W;
    c.height = PIC_H;
    c.getContext('2d')!.putImageData(data.original, 0, 0);
    winPic = { level, canvas: c };
  }
  const q = WIN.quad;
  const P = (i: number) => [L.x + q[i] * L.s, L.y + q[i + 1] * L.s];
  ctx.save();
  ctx.beginPath();
  for (let i = 0; i < q.length; i += 2) ctx.lineTo(P(i)[0], P(i)[1]);
  ctx.closePath();
  ctx.clip();
  const qx0 = Math.min(q[0], q[6]), qx1 = Math.max(q[2], q[4]), qy0 = q[1], qy1 = q[5];
  const side = Math.max(qx1 - qx0, qy1 - qy0) * L.s;
  ctx.drawImage(winPic.canvas, L.x + ((qx0 + qx1) / 2) * L.s - side / 2, L.y + ((qy0 + qy1) / 2) * L.s - side / 2, side, side);
  // a slow sheen across the glass
  const sweep = ((popupT * 0.45) % 1.6) - 0.3;
  const gx = L.x + (qx0 + (qx1 - qx0) * sweep) * L.s;
  const g = ctx.createLinearGradient(gx - 60 * L.s, 0, gx + 60 * L.s, 0);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.28)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(L.x + qx0 * L.s, L.y + qy0 * L.s, (qx1 - qx0) * L.s, (qy1 - qy0) * L.s);
  ctx.restore();
  ctx.drawImage(ui.win, L.x, L.y, WIN.w * L.s, WIN.h * L.s);
}

const inRect = (px: number, py: number, L: { s: number; x: number; y: number }, r: readonly number[]) =>
  px >= L.x + r[0] * L.s && px <= L.x + r[2] * L.s && py >= L.y + r[1] * L.s && py <= L.y + r[3] * L.s;

/** A tap while a popup is up (CSS px). */
function popupTap(px: number, py: number): void {
  if (popupT < 0.4 || clock - lastPopupAction < 0.5) return; // let it land; one action per press
  const L = popupLayout(canvas.clientWidth, canvas.clientHeight);
  const act = (id: string, fn: () => void) => {
    // the button dips first, then the action runs
    press('p:' + id);
    lastPopupAction = clock;
    setTimeout(fn, 140);
  };
  if (outcome === 'win') {
    if (inRect(px, py, L, WIN.next)) act('next', () => startLevel((level + 1) % LEVEL_COUNT));
    return;
  }
  const [x0, y0, x1, y1] = LOSE.close;
  if (Math.hypot(px - (L.x + ((x0 + x1) / 2) * L.s), py - (L.y + ((y0 + y1) / 2) * L.s)) < ((x1 - x0) / 2) * L.s) { act('close', () => startLevel(level)); return; }
  if (inRect(px, py, L, LOSE.ad)) { act('ad', () => void reviveWithAd()); return; }
  // no gem wallet in this build: the gem price is shown, the revive is free
  if (inRect(px, py, L, LOSE.gems)) act('gems', ownRevive);
}

async function reviveWithAd(): Promise<void> {
  if (reviveBusy) return;
  reviveBusy = true;
  try {
    // with the ads module off (standalone web / APK) there is no ad to show: revive straight away
    if (FalconSDK.ads.enabled && !(await FalconSDK.ads.showRewarded())) return;
    ownRevive();
  } finally {
    reviveBusy = false;
  }
}

/** One more slot to keep going; when the queue is already at its widest, the level restarts. */
function ownRevive(): void {
  if (!revive()) startLevel(level);
}

let lastTime = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  if (!paused) {
    update(dt * speed);
    updateWave(dt);
  }
  popupT = outcome ? popupT + dt : 0;
  for (const [id, t] of presses) { if (t > 1.2) presses.delete(id); else presses.set(id, t + dt); }
  for (const p of taps) p.t += dt;
  if (taps.length) taps = taps.filter((p) => p.t < 0.4);
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/** What the studio layer attaches to. See falcon-game.ts for every member. */
export const game: FalconGame = {
  getLevelCount: () => LEVEL_COUNT,
  startLevel,
  on: events.on,
  pause: () => { paused = true; },
  resume: () => { paused = false; },
  getProgress: () => (data ? Math.round((eatenCount / data.board.pieces.length) * 100) : 0),
  revive,
  setSpeed: (boost) => { speed = boost ? 3 : 1; },
  boosters: {
    defs: BOOSTERS,
    activate: activateBooster,
    isArmed: (key) => armed === key,
    cancel: (key) => { if (armed === key) armed = null; },
  },
};
