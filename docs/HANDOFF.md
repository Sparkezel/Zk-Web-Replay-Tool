# Handoff — replay playback bug RESOLVED (page ghost-crash), PR in flight

_Created 2026-11-21 late evening. Map-backdrop bug: closed (PR #5, merged)._

## The playback bug — root cause and fix (this session)

**Symptom**: pressing Play never starts the replay; seeking showed up to two units at a time (sometimes dying), past 1/3 only a single "fencer wreckage" dot.

**Root cause**: `mockup/index.html`'s `draw()` ghost-unit branch (merged with PR #5's wrecks feature) reads `u.track.length` on the **page-built** unit objects — but `buildArtifactModel()` maps units to objects that carry only a `posAt` closure and never copy `track`. Result: `TypeError: Cannot read properties of undefined (reading 'length')` inside the first `draw()` — which kills the `requestAnimationFrame(loop)` chain permanently:
- Play button toggles `playing` but nothing advances (loop dead) → "start doesn't work"
- every seek re-runs `draw()`: canvas cleared, units drawn in id order **until the first alive unit**, then throw → only the first couple of drawn units visible, later seeks leave one dot
- the synthetic fallback was equally broken (its alive units have no `track` either)

The 33 JS/TS tests stayed green because they test `mockup/replay.js` — the page's `buildArtifactModel`+`draw` pipeline was never executed anywhere. The artifact itself is healthy (1,399 units, EVNT 1400 spawns/1113 deaths/gameover, END 25:17, verified by decoding with the viewer code headlessly).

**Fix** (branch `vibe/viewer-page-crash-fix`):
- `buildArtifactModel` now copies `track` into the page unit objects
- the ghost branch guards `u.track&&` first (synthetic units have none — normal draw path)
- `test/viewer-page.test.ts` (NEW): runs the page's inline script headlessly (stub DOM/canvas/fetch), presses Play, drives 600 rAF frames and a timeline sweep — asserts real canvas drawing and no exceptions, for both the artifact and the synthetic-fallback paths. Without the html fix both tests fail; with it the suite is 35/35.
- `scripts/inspect-zkr.mjs` + `scripts/sim-viewer.mjs` (NEW): artifact dumping + full headless page sim — the debug tools that found this bug in minutes.

**IMPORTANT for viewing after pulling the fix**: http-server serves index.html/replay.js with `max-age=3600` — hard-refresh (Ctrl+Shift+R) after updating, or run the server with `-c-1`.

## Still open (unchanged)

1. Backlog issues #6–#10: gh-pages deployment, version bump, stale-branch cleanup, icon-sync docs.
2. `package.json` has a stray `"node": "^27.0.0-alpha"` dependency (local modification, uncommitted) that shadows PATH `node` via `node_modules/.bin/node` — the system node is **v16.16.0**, which cannot run `npm test` (needs ≥20). Decide: either commit the dep deliberately with a comment, or drop it and install Node ≥ 20 properly.
3. Optional hardening: daemon warns loudly when `mapName` is missing from the startscript; mockup README note re `-c-1`.
4. Only the first two teams' units are counted in the cnt1/cnt2 chips (7-team battles undercount; cosmetic).

## Environment notes

- `node_modules/node/bin/node.exe` = Node 27 alpha (works) — use `./node_modules/node/bin/node.exe` for scripts; `node` on PATH is v16.
- Battle data: `Demo/…Otago 1.4….sdfz`, staged data in `.zkr-work/` (junction to `D:\je\zbad steam\steamapps\common\Zero-K`), viewer served by http-server on **localhost:8081** (the 8080 Embedthis server is unrelated). Artifacts stay gitignored.
