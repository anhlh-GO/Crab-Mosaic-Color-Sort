// Plays a level the way the game's rules do (crabs eat the nearest reachable
// piece of their colour; boxes with blockers), for tuning the difficulty curve.
// Not part of the game: only the dev tuner imports it.
//
// Policies:
// - 'random': taps any box it is allowed to tap
// - 'smart':  prefers boxes whose colour it can see and the crabs can reach now;
//             a hidden box is a gamble it takes only when nothing better is left

import type { Board } from './segment';
import type { Nav } from './nav';
import type { TileDef } from './levels';

export type Policy = 'random' | 'smart';

interface Box { id: number; cls: number; left: number; hidden: boolean; ice: number; link: number }

export function playLevel(board: Board, nav: Nav, columns: TileDef[][], slots: number, policy: Policy, seed: number): boolean {
  nav.reset();
  let a = seed;
  const rnd = () => ((a = (a * 16807) % 2147483647) / 2147483647);
  const pick = <T>(l: T[]) => l[Math.floor(rnd() * l.length)];
  const eaten = new Uint8Array(board.pieces.length);
  let left = board.pieces.length;
  const cols: Box[][] = columns.map((c) => c.map((t) => ({
    id: t.id ?? -1, cls: t.cls, left: t.value, hidden: !!t.hidden, ice: t.ice ?? 0, link: t.link ?? -1,
  })));
  const slotted: Box[] = [];
  const start = nav.cell(Math.floor(nav.cols / 2), nav.rows);
  const done = (won: boolean) => { nav.reset(); return won; };

  for (;;) {
    // crabs eat until nothing in the slots can reach anything more
    for (;;) {
      let prog = false;
      const by = new Map<number, number[]>();
      for (const p of nav.frontier(start)) {
        if (eaten[p]) continue;
        const c = board.pieces[p].cls;
        if (!by.has(c)) by.set(c, []);
        by.get(c)!.push(p);
      }
      for (const b of slotted) {
        const l = by.get(b.cls);
        while (b.left > 0 && l && l.length) { const p = l.shift()!; eaten[p] = 1; nav.clear(p); b.left--; left--; prog = true; }
      }
      for (let k = slotted.length - 1; k >= 0; k--) if (slotted[k].left === 0) slotted.splice(k, 1);
      if (!prog) break;
    }
    if (left === 0) return done(true);
    const free = slots - slotted.length;
    if (free <= 0) return done(false);

    // what may be tapped: a free front box, or a chained pair both at the front
    const front = new Map<number, number>();
    cols.forEach((c, j) => { if (c.length) front.set(c[0].id, j); });
    const moves: number[][] = [];
    cols.forEach((c, j) => {
      const t = c[0];
      if (!t || t.ice > 0) return;
      if (t.link < 0) { moves.push([j]); return; }
      const j2 = front.get(t.link);
      if (j2 === undefined || j2 < j || cols[j2][0].ice > 0 || free < 2) return;
      moves.push([j, j2]);
    });
    if (!moves.length) return done(false);

    let move: number[];
    if (policy === 'random') move = pick(moves);
    else {
      const reach = new Set<number>();
      for (const p of nav.frontier(start)) if (!eaten[p]) reach.add(board.pieces[p].cls);
      const good = moves.filter((m) => m.every((j) => !cols[j][0].hidden && reach.has(cols[j][0].cls)));
      const gamble = moves.filter((m) => m.some((j) => cols[j][0].hidden));
      move = good.length ? pick(good) : gamble.length ? pick(gamble) : pick(moves);
    }
    for (const j of move) slotted.push(cols[j].shift()!);
    // every box sent cracks the ice a little
    for (const c of cols) for (const t of c) if (t.ice > 0) t.ice = Math.max(0, t.ice - move.length);
  }
}

/** Share of `n` runs won (0-100). */
export function winRate(board: Board, nav: Nav, columns: TileDef[][], slots: number, policy: Policy, n: number): number {
  let w = 0;
  for (let k = 0; k < n; k++) if (playLevel(board, nav, columns, slots, policy, 1000 + k * 77)) w++;
  return (w / n) * 100;
}
