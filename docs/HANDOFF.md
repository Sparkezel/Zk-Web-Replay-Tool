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

### 2. Pre-game chat — the ZK pick phase

ZK team battles record a lobby/pick phase BEFORE play: this battle has a 160-second tail ("I choose:" commander picks, SPRINGIE relays) up to the demo's **STARTPLAYING** netmsg at frame 4799. The viewer clock now anchors at `MACR.startPlayingFrame` (new field, parsed from the demo stream):

- everything (units, feed, eco, victory) is shifted — playback starts when play starts
- chat rows recorded before the anchor are tagged `pre` and **shown from the first frame** in the chat panel, labeled "lobby"

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
- `package.json`'s stray `node@27-alpha` dependency (shadows the system Node 16 — deliberate or drop it).
- cnt1/cnt2 chips only count the first two teams (cosmetic; 7-team battles undercount).
- Older viewer artifacts decoded with the fixed legacy cadence assumed `--pos-rate 1` (default); an artifact packed with `--pos-rate N` would need N× the cadence — acceptable, documented in replay.js.

## Environment notes

- Run scripts/tests with `./node_modules/node/bin/node.exe` (Node 27); bare `node` is v16.
- Battle data: `Demo/…Otago 1.4….sdfz`; `.zkr-work` staged junction → ZK install; viewer at http://localhost:8081 (8080 is an unrelated Embedthis server).
