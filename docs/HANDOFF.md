# Handoff — map-backdrop bug RESOLVED + PR #5 merge plan

_Created 2026-11-21 evening, branch `vibe/view-fixes-followup-c67cdf`, head `c91bf02` (revert of TEMP diagnostics)._

## State of the repo

- Repo: Sparkezel/Zk-Web-Replay-Tool. Draft **PR #5** `vibe/view-fixes-followup-c67cdf`, now ahead of its remote head by:
  - `c88a54b` mapimage: packed .sd7/.sdz map archive support via 7-Zip (the Otago fix)
  - `c91bf02` Revert of TEMP viewer diagnostics `d2ab3ab` (agreed pre-merge step — done)
- 33/33 local tests (`npm test`, includes 5 new mapimage tests; sd7/sdz round-trip tests skip cleanly where no 7-Zip exists, run for real here).
- `package.json` + `package-lock.json` have unrelated local modifications (a stray `node` dependency, predates this work) — **not committed, not pushed**. Deal with separately (probably `git checkout -- package*.json`).
- `mockup/battle.zkr` + `mockup/map.png` remain gitignored, regenerated on the user's machine.

## Map backdrop bug — root cause and fix (closed)

- **Root cause** (none of the earlier hypotheses): `findMapFile` only scanned for *loose* `.smf` files. A typical ZK install has hundreds of packed `.sd7` (7-Zip) map archives and almost no loose `.smf` files. `otago_1.4.sd7` was the battle's map; all 11 loose `.smf` files were unrelated maps (Vittra included), so `want="otago"` scored 0 everywhere and the first-found `.smf` (Vittra3.smf) won. The startscript parser (`mapname=Otago 1.4;`) and dist freshness were both fine all along.
- **Fix**: `findMapSource()` scores loose `.smf` **and** `.sd7`/`.sdz` archives by normalised-name overlap (ties: loose `.smf` wins, then closest key length — `Otago 1.4` beats `Otago Redux 1.4`). `extractMapImageFromArchive()` streams the archive's (single) `.smf` via 7z (`ZKR_7Z` env → Program Files → PATH), decodes the minimap with the existing DXT1 path. Warnings added for missing 7-Zip. Note: the inner `.smf` name can share nothing with the display name — `otago_1.4.sd7` ships `maps\lavamountains.smf` — so a lone entry is always taken.
- **Verified end-to-end** (no-resim run against the real staged data):
  `map backdrop extracted: map.png (512x512) from otago_1.4.sd7 [sd7] (startscript mapName="Otago 1.4")`.
- After the next full daemon run, hard-refresh the browser (Ctrl+Shift+R); http-server defaults to an hour of cache. Consider `http-server -c-1` while iterating.

## Still open

1. `[zkr-probe]` console block **never captured** — the earlier "only 1 commander, playback stalls at frame 5" report is still unconfirmed. With map + artifacts healthy on two resim runs, the stale-dist/cache stack remains the leading theory, but don't patch viewer decode paths without this evidence.
2. Backlog issues #6–#10: gh-pages deployment, version bump, stale-branch cleanup, icon-sync docs.
3. Optional hardening (not done): daemon warns loudly when `mapName` is missing from the startscript; mockup README note re `-c-1`.

## Agreed merge sequence (from here)

1. Push the branch (fix + revert commits) → PR #5 CI goes green.
2. Mark PR #5 ready for review → merge.
3. Delete stale remote branches (backlog #7), open a fresh `vibe/...` branch off `main` for #6 gh-pages, #9 version bump, #10 icon-sync docs.

## Environment notes

- Use the `gh` CLI (authenticated) for all GitHub operations; never create new repositories; `battle.zkr`/`map.png` artifacts are never committed.
- 7-Zip present at `C:\Program Files\7-Zip\7z.exe` on the user's machine (also found via PATH or `ZKR_7Z`).
- ZK game install (data root used for staging): `D:\je\zbad steam\steamapps\common\Zero-K`.
