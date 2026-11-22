# Handoff — unit-sync + pre-game chat + cloak recording

_Created 2026-11-22 morning. Playback crash (PR #11) and map backdrop (PR #5) both resolved and merged or in flight as applicable._

## What was found and fixed this session

### 1. Unit/wreck sync — the probe-cadence loss (root cause of ALL symptom reports)

The snapshot widget probes every unit every 6th engine frame (0.2 s), but POS v1 stored no per-sample timing and the viewer decoder assumed **one sample per frame**. Everything played at 6× and every unit's track "ended" after 1/6 of its real life:

- structures "turned into wrecks after a few minutes" (ghost rendering of tracks that stopped early)
- end-game clutter of "dead" idle units with red hp rings (ghosts frozen at stale hp — nobody cleaned them up)
- constructor motion appeared to run far ahead of the structures it built ("solar chain delayed ~2 minutes")
- measured on the real battle: solars "lived" 240 s in the viewer vs 900+ s real; exactly 283 units were ghosts — after the fix: **0 ghosts**, tracks now end within ~4 frames of their real death events

**Fix**: POS/PROJ sections bumped to **v2** with a per-sample `s16 frameDelta` (POS samples also gain a cloak flag byte). Legacy v1 artifacts are decoded with the historical fixed cadence (firstFrame + 6k) — so existing artifacts display correctly without a re-run.

### 2. Pre-game chat — the ZK pick phase, and TWO CLOCKS (counter-review find)

ZK team battles record a lobby/pick phase BEFORE play: ~164 s of "I choose:" commander picks and SPRINGIE relays, ending at the demo's STARTPLAYING events (frame 4799 with a 4000 ms countdown payload, then 4918 with 0). Critically, the artifact mixes two clocks:

- **resim sections (POS/EVNT/PROJ/LINK/STBX/UDEF/WDEF)** run on *engine play frames* — the engine does not simulate during the pick phase, so their frame 0 already IS play start. NEVER anchor-subtract these.
- **demo-derived sections (CHAT/DRAW/MACR/ECO/PSTA/META)** run on absolute demo frames and must be shifted by `MACR.startPlayingFrame` = the LATEST startplaying candidate (frame + countdown; first naive version subtracted from resim frames too and erased the game's first 160 s — caught by adversarial review, fixed, verified: END 25:23, feed from 6.7 s, lobby chat pre-shown at tm<=0).

`fmt()` now clamps negatives (pre-game rows show the "lobby" label instead of a time anyway).

**Migration for existing artifacts**: `node scripts/repack-zkr.mjs mockup/battle.zkr <demo.sdfz>` rebuilds the demo-derived sections (META/ROST/CHAT/MACR/…) and carries the resim sections (POS/EVNT/…) — anchors the old artifact without a resim. Already applied to `mockup/battle.zkr` (backup at `battle.zkr.v1.bak`).

### 3. Cloak recording (Iris + cloaked units) — needs one resim re-run

- widget: pos rows gained a cloak bit (`Spring.GetUnitIsCloaked`); udef lines gain `"cr"` = area-cloak radius from a Cloaker-type weapon's range or a `*cloak*` custom param
- daemon: `UnitDefInfo.cloakRadius`, `PosSample.cloaked`; UDEF section v2, row gains the radius column (fallback 350 for `cloakjammer` in the viewer); META gets real map dims from the widget (`map.dims = [w, h]` elmos) so circles can scale
- viewer/page: units with `cloakRadius` draw a light-blue translucent field scaled by `radius/mapW`; cloaked units draw a small cyan dot beneath their icon
- **only activates after the next full daemon re-run** (widget + packer changes); the current artifact carries no cloak bits and no META dims, so circles are skipped gracefully

## Re-run instructions (one daemon run, ~15 min)

```
node dist/daemon/index.js --demo "Demo/....sdfz" --work-dir .zkr-work \
  --out mockup/battle.zkr --data-root "D:/je/zbad steam/steamapps/common/Zero-K"
```
then hard-refresh the browser (http-server caches index.html/replay.js for an hour).

## Still open

- Backlog #6/#9/#10 (gh-pages, version bump, icon-sync docs).
- `package.json`'s stray `node@27-alpha` dependency is an UNCOMMITTED local mod (not on any branch — a reviewer flagged it as committed, that was wrong); decide: commit deliberately or drop it.
- Legacy v1 decode caveats (documented in replay.js): v1 sections carry no cadence metadata, so an artifact packed with `--pos-rate N` decodes N× mis-timed (v2 with true deltas is immune); `u16 sampleCount` truncates tracks > 65535 samples (≈3.6 s at 5 Hz… 2.2 h — unreachable in practice); `s16` deltas cannot represent a single-probe jump > 32768 elmos (Djinn teleports between probes would wrap).
- Cloak radius fallback: `cloakjammer` → 350 hard-coded only when the runtime capture missed ZK's `area_cloak_radius` custom param (matched exactly now; `area_cloak_recloak_rate` etc. no longer win the `pairs()` lottery). `staticjammer` (Iris morph) has no fallback — its radius comes from the runtime capture.
- cnt1/cnt2 chips only count the first two teams (cosmetic; 7-team battles undercount).

## Environment notes

- Run scripts/tests with `./node_modules/node/bin/node.exe` (Node 27); bare `node` is v16.
- Battle data: `Demo/…Otago 1.4….sdfz`; `.zkr-work` staged junction → ZK install; viewer at http://localhost:8081 (8080 is an unrelated Embedthis server).
