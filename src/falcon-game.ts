// The contract between a Falcon game and the studio layer.
//
// A game implements `FalconGame` — a handful of functions and three events —
// and hands it to `registerFalconGame`. Everything the studio adds around the
// game (header, coins, popups, shop, ads, lives, rating, analytics) is wired to
// THIS interface by Falcon IDE at publish time, on a copy of the project, with
// no AI involved. The gameplay code never has to know any of that exists.
//
// In development (Preview, `npm run dev`) nothing is wired: `registerFalconGame`
// boots the SDK minimally and starts the game, so the same source runs as-is.
//
// This file is owned by Falcon IDE (the "New game" scaffold writes it, the
// publish build reads it). Edit the game, not this file: a changed contract is
// a game the studio layer cannot attach to.

import FalconSDK from '@falcongames/game-client-sdk';

/** Bumped when the contract changes shape. The publish build refuses a game whose file is newer than the IDE. */
export const FALCON_GAME_CONTRACT = 1;

/** What a game reports when a level's board is ready to play. */
export interface FalconLevelStart {
  /** 0-based level index, the same numbering `startLevel` takes. */
  index: number;
  /** For analytics; 'normal' when the game has no notion of it. */
  difficulty?: 'easy' | 'normal' | 'hard' | (string & {});
  /** The level's own id when it has one (a file name, a seed). */
  levelId?: string;
}

export interface FalconGameEvents {
  /** The board of level `index` is built and playable. Fire once per (re)start, never at boot only. */
  levelStart: [FalconLevelStart];
  /** The player cleared the level. */
  win: [];
  /** The round is lost. `canRevive` = the game can continue it if the studio layer pays for a revive. */
  lose: [{ canRevive: boolean }];
}

export interface FalconBoosterDef {
  /** Stable key, used in analytics and as the shop item id. */
  key: string;
  title: string;
  desc: string;
  /** Coins for `qty` units. */
  price: number;
  qty: number;
  /** First level the booster is available at (1-based, as the player sees it). */
  unlock: number;
}

export interface FalconGame {
  /** How many levels exist. */
  getLevelCount(): number;
  /**
   * Enter level `index` (0-based) and land STRAIGHT in gameplay: close any
   * menu, splash or popup of your own. Called at boot, on "next level", on
   * retry — and by the IDE to photograph and verify the game.
   */
  startLevel(index: number): void;
  /** Subscribe to the three lifecycle events. Returns the unsubscribe. */
  on<K extends keyof FalconGameEvents>(event: K, fn: (...args: FalconGameEvents[K]) => void): () => void;

  /** Stop time and input while a studio popup covers the game; `resume` undoes it. */
  pause?(): void;
  resume?(): void;
  /** 0–100, how far the current level is, asked when the round is lost. */
  getProgress?(): number;
  /** Continue the lost round after a paid revive. Return false if it cannot. */
  revive?(): boolean;
  /** The header's speed toggle. */
  setSpeed?(boost: boolean): void;
  /** Sound / music / haptic toggles in the header's settings. */
  audio?: {
    set(key: 'sound' | 'music' | 'haptic', on: boolean): void;
    get(key: 'sound' | 'music' | 'haptic'): boolean;
  };
  /**
   * Boosters the studio's booster bar sells and shows. The game owns what a
   * booster DOES; the studio layer owns the wallet, the counts and the UI.
   */
  boosters?: {
    defs: FalconBoosterDef[];
    /** Use one unit of `key` now. Return false when it cannot apply (the player keeps the unit). */
    activate(key: string): boolean;
    /** A booster that stays "armed" waiting for a pick, if the game has such. */
    isArmed?(key: string): boolean;
    cancel?(key: string): void;
  };
}

/** A small typed emitter a game can build its events on. */
export function createFalconEvents(): {
  on: FalconGame['on'];
  emit<K extends keyof FalconGameEvents>(event: K, ...args: FalconGameEvents[K]): void;
} {
  const listeners = new Map<string, Set<(...args: never[]) => void>>();
  return {
    on(event, fn) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(fn as (...args: never[]) => void);
      return () => set!.delete(fn as (...args: never[]) => void);
    },
    emit(event, ...args) {
      for (const fn of [...(listeners.get(event) ?? [])]) (fn as (...a: unknown[]) => void)(...args);
    },
  };
}

declare global {
  interface Window {
    /** The registered game. */
    __FALCON_GAME__?: FalconGame;
    /** How Falcon IDE drives the game from outside (preview Level box, thumbnails, verification). */
    __FALCON_PUBLISH__?: { getLevelCount(): number; startLevel(index: number): void };
  }
}

const gameId = (): string => import.meta.env.VITE_FALCON_GAME_ID ?? 'dev';

/**
 * Boot the game on the Falcon SDK. Call once, after the game object exists.
 *
 * What this wires is the ALWAYS-ON half of the SDK: the shell bridge, the save
 * (userData) and level analytics (`log_level` Start/Pass/Fail — what the
 * dashboard and the IDE's publish verification read). The optional modules —
 * ads, lives, remove-ads, shop — are OFF by default (SDK 1.3); pass their
 * configs through `options` when the game uses them, and build their UI in the
 * game's own style. At publish time the CMS switches have the final word: a
 * module the server turns off is off in the shipped build, whatever is here.
 *
 * Returns the SDK instance; `import FalconSDK from '@falcongames/game-client-sdk'`
 * anywhere in the game reaches the same instance after this ran.
 */
export function registerFalconGame(game: FalconGame, options?: Omit<FalconSDK.Options, 'gameId'>): FalconSDK.SDK {
  window.__FALCON_GAME__ = game;
  window.__FALCON_PUBLISH__ = {
    getLevelCount: () => game.getLevelCount(),
    startLevel: (index) => game.startLevel(index),
  };
  const SDK = FalconSDK.init({ ...options, gameId: gameId() });
  const levelKey = `${gameId()}_level`;
  void SDK.userData.load().then(() => {
    const fromQuery = Number(new URLSearchParams(location.search).get('level'));
    const saved = Number(localStorage.getItem(levelKey));
    const first = Number.isFinite(fromQuery) && fromQuery > 0 ? fromQuery - 1 : Number.isFinite(saved) ? saved : 0;
    game.startLevel(Math.max(0, Math.min(game.getLevelCount() - 1, first)));
    SDK.bridge.gameReady();
  });
  // The log_level skeleton: every level start opens a turn, win/lose closes it.
  game.on('levelStart', ({ index }) => {
    localStorage.setItem(levelKey, String(index));
    SDK.analytics.turn.begin({ level: index + 1 });
  });
  game.on('win', () => { if (SDK.analytics.turn.isActive()) SDK.analytics.turn.end('Pass'); });
  game.on('lose', () => { if (SDK.analytics.turn.isActive()) SDK.analytics.turn.end('Fail'); });
  return SDK;
}
