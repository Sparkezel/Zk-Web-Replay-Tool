# Zk-Web-Replay-Tool
A project meant to embed zk game replays into the battle result screen with goal of easier replay access and showing cool info

## Mockup

Static mockup of the battle-result screen with an animated battle replay section.
After merging, it will be served at https://sparkezel.github.io/Zk-Web-Replay-Tool/

- Source: [`mockup/index.html`](mockup/index.html)
- The replay stage renders a `battle.zkr` artifact placed next to the page
  (unit position tracks, kill events, projectile paths, economy, victory).
  Without one it falls back to a synthetic seeded preview.
- To regenerate the artifact on a machine with an unpacked engine:
  `node dist/daemon/index.js --demo <battle.sdfz> --out mockup/battle.zkr`

## Logging spec

`.zkr` v1 artifact contract (what the headless resim records and the viewer
consumes): [`docs/REPLAY_LOGGING_SPEC.md`](docs/REPLAY_LOGGING_SPEC.md)

## Live demo

After enabling GitHub Pages (Settings → Pages → Deploy from branch `gh-pages`):
https://sparkezel.github.io/Zk-Web-Replay-Tool/

## M1 — demo parser + `.zkr` writer

- `src/demo/` — `.sdfz` demo parsing: 352-byte header, startscript (rosters,
  allyteams, modoptions, commanders), network-message stream (chat, mapdraws,
  start positions, game-overs, player stats, per-type chunk counts), winners,
  player/team stat blocks. Usable from Node: `parseSdfzFile(path)`.
- `src/zkr/` — `.zkr` v1 sectioned artifact (per
  [`docs/REPLAY_LOGGING_SPEC.md`](docs/REPLAY_LOGGING_SPEC.md)); cheap-parse
  sections (META/ROST/PSTA/ECO/MACR/CHAT/DRAW) written from the demo alone,
  POS/EVNT/PROJ/LINK follow with the M2 headless resim.
- Validated against battle [2539874](https://zero-k.info/Battles/Detail/2539874)
  (1.75 MB demo → 96 KB artifact; gameID 3da5f96a… matches End-of-file stats).

## M3 — mockup viewer wiring

- [`mockup/replay.js`](mockup/replay.js) — browser decoder for the `.zkr`
  sections (`POS `/`EVNT`/`PROJ`/`LINK` binaries + JSON sections) and a
  render-model builder; parity-tested against the Node packer in
  `test/viewer.test.ts`.
- `mockup/index.html` fetches `battle.zkr` (same directory), renders unit
  tracks interpolated between probes, dash-dot-dash Djinn↔Lamp links,
  projectile tracers, the kill feed and the metal economy chart; falls back
  to the synthetic preview when the artifact is missing or carries no
  unit tracks (cheap-parse artifact without engine resim).
- Endgame state (`gameover` rows in `EVNT`) drives the victory overlay and
  the timeline length.
