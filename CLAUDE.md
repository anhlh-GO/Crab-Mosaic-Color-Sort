# Jigsaw Hunt — notes for the AI assistant

This is a Falcon web game: Vite + TypeScript, built to ONE `dist/index.html`, shipped inside the Falcon shell app.

## The game runs on the Falcon Game Client SDK

`src/game.ts` exports `game: FalconGame` and `src/main.ts` hands it to `registerFalconGame(game)`
(see `src/falcon-game.ts` for every member). That call boots the ALWAYS-ON half of the SDK — the shell bridge,
the save (`userData`) and level analytics (`log_level`: a turn opens on `levelStart`, closes on `win`/`lose`).
Keep the contract honest:

- `startLevel(index)` (0-based) lands STRAIGHT in gameplay: close your own menus, splash and popups yourself.
- Emit `levelStart` when the board is ready to play (every start and restart, never only at boot).
- Emit `win` when the level is cleared, `lose` when the round is lost.
- `pause()` / `resume()` freeze time and input.

## Optional features: build them when asked, in THIS game's own style

Ads, shop/IAP, lives, remove-ads, boosters, a next-level flow — none of these is pre-built or forbidden.
When the developer asks for one, BUILD IT: design the UI to match the game, and drive it through the SDK
(the logic — store calls, ad calls, lives regen, purchase grants — is the SDK's job, never re-implement it):

- Get the SDK instance from `registerFalconGame`'s return value, or `import FalconSDK from
  '@falcongames/game-client-sdk'` anywhere (same instance once registered).
- Module configs go through the second argument: `registerFalconGame(game, { ads: { minLevel: 10 },
  lives: { max: 5, regenSec: 1800 }, shop: { enabled: true }, packs: [...] })`. A module is OFF until it
  gets a config (SDK 1.3); off modules answer locally (`ads.showRewarded()` → false, lives stay full).
- Call sites: `SDK.ads.showRewarded()` / `SDK.ads.maybeShowInterstitial(level)`, `SDK.shop.open()`,
  `SDK.iap.onGrant(...)`, `SDK.lives.*`, `SDK.removeAds.*`, `SDK.analytics.turn.tick(dt)` /
  `turn.useBooster(key)` for richer analytics.
- Let feature UI check its module (`SDK.ads.enabled`, `SDK.shop.isEnabled()`) and hide when off: at
  publish time the server's CMS switches have the FINAL word — a module the server turns off is off in the
  shipped build, one it turns on is on — whatever the code passed.

Do NOT: edit `src/falcon-game.ts` (IDE-owned), call `FalconSDK.init()` yourself (`registerFalconGame`
already did; a second init is ignored with FSDK-001), or hard-code a `gameId` anywhere — it is set to the
game's package name at publish time.

## Working here

- `npm run dev` or the IDE's Preview runs the game. `?level=N` jumps to a level.
- `npm run build` must keep producing exactly one file, `dist/index.html`.
- Assets go through Vite imports so they are inlined into that one file.
- The studio-layer numbers a reviewer may tune live in `.falcon/sdk-config.json`.
