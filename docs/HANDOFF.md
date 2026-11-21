# Handoff — map-backdrop bug + PR #5 status

_Created 2026-11-21, branch `vibe/view-fixes-followup-c67cdf`, head `9b1f966`._

## State of the repo

- Repo: Sparkezel/Zk-Web-Replay-Tool. Open draft **PR #5** `vibe/view-fixes-followup-c67cdf`, head **`9b1f966`** (verified pushed; CI green on ubuntu+windows; 28/28 local tests).
- PR #5 contains:
  - team-palette ramps + lightness zigzag (e12070e)
  - player names in feed, startboxes, dds icon fixes
  - **`findMapFile(roots, mapName)` name-overlap picker (dfb9561)**
  - **TEMP console diagnostics on artifact load (d2ab3ab) — to be reverted before merge**
  - **daemon logs parsed `mapName` on the map-extraction line (9b1f966)**
- Backlog (issues #6–#10): gh-pages deployment, version bump, stale-branch cleanup, icon-sync docs.
- Stack: TS daemon (`src/daemon/*.ts` → `tsc` → `dist/`, no runtime deps, node ≥ 20), plain-JS viewer (`mockup/replay.js` + inline script in `mockup/index.html`), `npm test` = `tsc && node --test test/*.test.ts`. `mockup/battle.zkr` + `mockup/map.png` are **gitignored** — generated on the user's Windows machine, never committed.

## Active bug: map backdrop is still Vittra for an Otago battle

**Symptom**: daemon logs
`map backdrop extracted: mockup\map.png (512x512) from Vittra3.smf`
on every re-run, even after pulling `dfb9561`. Reference battle zero-k.info/Battles/Detail/2539874, expected map `otago_1.4.sd7`.

**Beautiful part of the evidence**: the resim itself is fully healthy — two runs (`zkrLines=42767` and `42900`, both `phase=over`, engine exited code=0, artifacts ~1.80–1.81 MB, map reached frame 45628/46388 of 50424 because the game ended there). Artifact truncation is **ruled out** as the cause of earlier viewer symptoms.

**Hypotheses, ranked**:

1. **`demo.roster.mapName` is `undefined`/wrong-prefixed for this real startscript** (the parser test only asserts a synthetic fixture returning `"Otago 1.4"`). If `undefined` → `want = ""` → every `keyOverlap` score = 0 → *first .smf found wins* → Vittra (first in filesystem order). If the real name is path- or archive-prefixed (e.g. `Maps/Otago 1.4` or `otago_1.4.sd7`), the key computed on the startscript name may share no common prefix with the on-disk `.smf` key → same fallback. **The new `mapName=...` field on the extraction log line decides this in one run.**
2. **`dist/` not rebuilt** after pulling `dfb9561` — the old compiled `findMapFile(roots)` silently ignores the second argument. Distinguish by grepping `dist/daemon/mapimage.js` for `smfKey`/`keyOverlap` and comparing dist mtimes to pull time.
3. **Browser cache red herring**: http-server serves with `Cache: 3600`; Firefox keeps `index.html`, `replay.js` and `map.png` for up to an hour — a stale Vittra `map.png` can persist *even after a correct extraction*. Hard-refresh (Ctrl+Shift+R) or serve with `http-server -c-1`.

## Next steps (in order)

1. User machine: `git pull` → `npm run build` → re-run daemon → read the extraction line: `startscript mapName=("...")`.
2. If `null`/unexpected → fix `src/demo/startscript.ts` mapName parsing against the **real** generated startscript (check the actual `mapname` key the battle's script writes — sections/keys may differ in case from the fixture).
3. If a real name but still Vittra → adjust `smfKey`/`keyOverlap` (e.g. strip a `Maps/`-style path or `.sd7`/`.otm` suffix before keying; add a regression test with the real string).
4. Hard-refresh the browser, capture the **`[zkr-probe]` console block** from `mockup/index.html` (raw bytes, section table, POS unit/firstFrame stats, MODEL END, visible@0s/@5s) — still never received; needed to close the earlier "only 1 commander, playback stalls at frame 5" report (believed to be the stale-dist/cache stack, but unconfirmed).
5. Agreed merge sequence: revert TEMP diagnostics commit `d2ab3ab` → mark PR #5 ready for review → merge → delete stale remote branches (backlog #7) → open a fresh `vibe/...` branch off `main` for #6 gh-pages, #9 version bump, #10 icon-sync docs.
6. Optional hardening: daemon warns loudly when `mapName` is missing from the startscript; note `-c-1` (cache-off) http-server flag in the mockup README so iterative daemon runs are visible without hard-refresh.

## Environment notes

- Use the `gh` CLI (authenticated) for all GitHub operations; never create new repositories; `battle.zkr`/`map.png` artifacts are never committed.
- Have **not** seen the user's `[zkr-probe]` output; do **not** patch `trackAt`/palette/POS decode paths without that evidence — viewer code is test-green and the two resim runs produced complete artifacts.
