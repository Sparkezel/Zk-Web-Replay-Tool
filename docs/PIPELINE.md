# The ZK Web Replay Tool — implementation & pipeline

This document describes the program as it works **today**, then how it got
there — including the mistakes that shaped it. It is written for a developer
joining the project; `docs/REPLAY_LOGGING_SPEC.md` carries the byte-level
`.zkr` contract and `README.md` the milestone history, so this file stays at
the level of "what happens, why, and what bit us".

---

## Part 1 — How it works right now

### What the tool is

A static website (GitHub Pages) that plays back Zero-K replays in the
browser: a top-down map with every unit, its health, shields, cloaks,
engagement arrows, projectile flights, missile strikes, wreckage fields,
chat, votes, economy and the battle feed — scrubbable at any speed. No
playback server: everything renders from a compact, self-contained
`.zkr` artifact produced ahead of time on a machine with the game.

The pipeline has three stages:

```
demo (.sdfz) ──► headless engine resim with injected Lua widget
                    │  "ZKR <json>" lines on stdout
                    ▼
               daemon ingest ──► pack to .zkr (deflate, sectioned binary)
                    ▼
               browser: fetch → inflate → decode → canvas renderer
```

### Stage 1 — the resim (recorder)

A Zero-K demo stores only player inputs; the deterministic engine
recomputes everything else. So the pipeline **re-simulates** the game with
`spring-headless`, at maximum speed, with a read-only Lua widget injected
into the game (`src/daemon/snapshot_widget.ts`, compiled into
`SNAPSHOT_WIDGET_LUA` and placed in the work dir's LuaUI widget folder).

The widget samples the engine and echoes one JSON per line to stdout:

- **POS** — every 6th engine frame (0.2 s): unit id, x/z elmos, hp/build
  fractions, cloak bits (cloaked, area-cloak field active/stalled) and
  shield charge. Lines are chunked under ~2 KB: the engine hard-caps a
  single console line near 32 KB, which used to chop long `pos` lines into
  malformed JSON on big battles.
- **STAT** — sparse state events at 1 Hz, only on change: slow level
  (quantized to 1/16) and a bit set for on-fire / disarmed / EMP-stunned.
  EMP reads the second value of `GetUnitIsStunned` (paralysis alone); the
  first value also counts nanoframes (see Part 2). Hidden units are skipped:
  Zero-K scripts paralyze a popped Claw mine and a launched silo missile
  while they wait unseen to be removed.
- **EVNT** — lifecycle: spawn, death (with killer unit/team/weapon),
  finished, transfer, gameover, wreck created/reclaimed, and **engage**
  rows (who damaged whom — victim change plus a 0.6 s keep-alive, so a
  fight never flickers but a big 8v8 stays in the thousands of rows).
- **PROJ / PTGT** — projectile positions for the weapon classes the viewer
  draws (see the classifier below) and, for strategic missiles, their
  *commanded* target (Spring's `GetProjectileTarget`, whose real return
  shape is `(typeChar, target)` with ground targets as an array table —
  that shape had to be learned the hard way).
- **MESP / STBX / CHAT / votes / PSTA** — metal spots, startboxes, chat,
  running poll state, player statistics — all read from the demo side too.

Projectile classification (mirrored in `src/daemon/classify.ts` and the
widget's Lua so both agree):

| class | meaning | rule |
|---|---|---|
| 0 | dropped | AircraftBomb, Melee, Shield, Torpedo; `fake`/`bogus` proxies |
| 1 | beam | BeamLaser/LaserCannon ≥ 900 elmos, LightningCannon at any range, plus named overrides (the fat-laser set) |
| 2 | artillery arc | Cannon ≥ 1000, or lobbed (trajectoryHeight > 0) ≥ 800; napalm weapons first regardless |
| 3/4 | strategic / missile | nuke-carrying Starburst, MissileLauncher ≥ 900 |
| 5 | interceptor | `customParams.interceptor` |

Engagement arrows have their own filters: strategic missile units and
**artillery units** (a census of the ZK units whose own descriptions say
"artillery") never draw arrows — weapon-level gates provably cannot catch
them (Firewalker's mortar is a Cannon *without* trajectoryHeight,
Merlin's rockets fly flat at th=1). Four artillery units — Sling,
Racketeer, Impaler, Phantom — were later reinstated by design decision
and instead get painterly arrow colours.

Operational facts learned about resims:

- The playback port is **baked into the demo recording** (8452 for our
  Otago demo). Two resims of the same game cannot run in parallel; the
  daemon now detects the bind failure loudly.
- A failed/empty capture falls back to a `*.cheap.zkr` (demo-parse only)
  and **never clobbers** the real artifact.
- Malformed ZKR lines and the stop point go to `.zkr-work*/logs/errors/`
  as timestamped reports.
- Wall time is dominated by the engine simulation itself (0.4–4.3× game
  speed depending on battle intensity), not by sampling: `--pos-rate`
  downsamples at pack time and changes nothing about resim duration.
- `--stop-after-game-min N` produces a truncated TEST artifact whose
  timeline ends at the stop frame.

### Stage 2 — the `.zkr` container

`src/zkr/container.ts` + `src/daemon/pack.ts`. Magic `ZKR`, a container
version, then versioned, independently deflated sections: `META`, `ROST`,
`UDEF`, `WDEF`, `POS` (v3), `EVNT`, `PROJ` (v2), `PTGT`, `LINK`, chat,
drawings, economy, votes, `PSTA`, `MESP`, `STBX`, `STAT`.

- POS v3: per-unit header (id, def, first frame, origin quantized to u16)
  then 9 bytes per sample: s16 Δx, s16 Δz, s16 frame delta, u8 hp, u8
  build, u8 flags (cloaked / area-field / stalled), u8 shield charge.
- PROJ: the same idea for projectile paths, split when a proID is reused
  after an 18-frame gap.
- EVNT: flat 17-byte rows.
- All section versions exist because of real decode bugs — see Part 2.

The compression is `deflate` (browsers ship
`DecompressionStream("deflate")`; they do not ship zstd).

### Stage 3 — the viewer

`mockup/` is the site: `index.html` (page + renderer), `replay.js`
(decoder + shared model), `icons/`, `fx/` (SVG trefoils).

1. **Load**: fetch the catalog entry → inflate sections → `replay.js`
   builds the artifact model: units with position tracks, flights,
   explosions, napalm patches, engagements, wrecks + zones, chat, votes,
   eco, players. The page model copies fields **explicitly** — a new
   model field does nothing until it is plumbed by hand into the page
   (this bit us exactly once).
2. **Render**: one canvas, layered: backdrop → under-fields (metal spots,
   wreck dots, zones, shield/cloak fields) → strike circles + intercept
   trefoils → antinuke coverage (hatched union, hover spotlight, disabled
   part blinks red) → conflict arrows → unit icons + decorations (build
   bar, state dots, hpv2 tint, shield bar) → projectile flights
   (15-sample fading trails for strategic flights, fat purple beams for
   the named laser set). DOM side: battle feed, chat, per-player grid,
   economy sparkline — all signature-skipped so they don't re-render
   unchanged frames.
3. **Playback loop**: a rAF governor advances the replay clock every tick
   but drops every other *drawn* frame when a frame took >20 ms, and
   draws nothing at all while paused and unmoved. Explosions decay in
   sim time (deterministic under seeks); flashes blink in wall time.
4. **Observability**: a **renderer profile panel** (per-layer avg/max ms,
   renderer fps vs rAF ticks — the two diverging is the exact signature
   of dropped frames) and a **diagnostics panel** (missing icons, NaN
   positions, script errors; each unique message once).

Current known limits, deliberately parked:

- The decode is **typed-array (structure-of-arrays)** as of the
  viewer/typed-arrays rewrite: per-unit column buffers (t/x/y Float32,
  hp/bd/flags/shield Uint8, ~15 bytes per pos sample) instead of the
  original object-per-sample (~100–130 bytes). Measured on the 5 Hz
  Otago artifact: ~1 GB heap → ~100 MB total, load 1,589 ms → 453 ms,
  identical rendering (byte-identical canvas-call counts in the smoke).
  The object decode OOMed at >8 GB on the full Comet Catcher stress
  recording; the typed-array decode brings it to a loadable size.
- The profiler names the **unit icon loop** as the heaviest render layer;
  the follow-ups are a per-frame `posAt` memo, viewport culling, an icon
  atlas, and (endgame) WebGL instancing.
- The recorder/decoder pair is due a maintainability rewrite together
  with the typed-array change (naming: the toggle says "conflict arrows",
  the internal id is still `targets`).

### Testing

- `node --test --experimental-strip-types test/*.test.ts` — 64 tests:
  daemon (classifier, ingest, pack), viewer parity (the browser decoder
  must recover exactly what the daemon packed), page tests (the inline
  page script runs headless with recording canvas/document stubs).
- `node scripts/sim-viewer.mjs mockup/<art>.zkr` — drives the *actual*
  page against a real artifact and reports canvas guard errors
  (`--fx` decodes images so the tint/fx pipelines execute).
- Every feature was additionally verified against real artifact bytes
  (flight counts, engage row counts, blast radii), because fixtures
  alone have repeatedly missed timing/shape bugs.

---

## Part 2 — How we got here: mistakes and their fixes

A selection, roughly in pipeline order. Every item below was real,
measured on real artifacts, and fixed:

**Recorder / format**

- **The build column was dead on arrival.** The widget's
  `frac(build and 1 or nil)` always emitted 1 — Lua truthiness: any
  non-nil number is true. Build bars never drew on real recordings; tests
  passed because fixtures injected values directly.
- **v1 POS had no per-sample timing.** The decoder assumed one sample per
  frame; with the widget probing every 6th frame, unit motion compressed
  to a sixth of real time. POS v2 added frame deltas. v3 added the
  area-cloak field bits and the shield charge byte — and v2 decoders must
  NOT read the new bits (padding read as 0 — version gates everywhere).
- **32 KB console cap.** A big battle blew the engine's single-line cap;
  the JSON tail came out as "malformed ZKR line" spam on the stress
  replay. Fix: chunk pos lines to ~2 KB (the daemon ingest merges them).
- **Rules params are numbers, not strings.** `GetUnitRulesParam(uid,
  "on_fire") == "1"` never fires — the engine returns numbers (ZK's own
  healthbars compare `== 1`). Two of four live states silently never
  recorded until this was found by diffing a fresh STAT census.
- **`GetUnitIsStunned` is true for nanoframes.** Its first value is
  "stunned or being built", so every unit under construction wore a yellow
  EMP dot. The widget now reads the second value (paralysis alone); the
  page keeps a build-completion gate for artifacts recorded before.
- **`GetProjectileTarget` shape.** The recorder accepted
  `(a,b,c,d)` numbers or a table with `.x/.z`. The engine actually returns
  `(typeChar, target)` with ground targets as an **array** table
  (`[1]=x, [3]=z`) — ground-targeted strategic missiles never recorded
  their destination, which made antinuke interceptions unreadable. Fixed
  by reading the real shape, including feature targets via
  `GetFeaturePosition` (separate id space!).

**Classifier**

- **"party" name filter ate real weapons.** `jumparty` (Firewalker) and
  `raveparty` (Disco) legitimately contain "party"; the napalm sprayer
  and the disco's colour cannons were silently dropped wholesale. The
  fake-unit patterns now exclude only `fake`/`bogus`, and napalm
  classification runs *before* name filters.
- **Ballistic test over-reached.** "Artillery = trajectoryHeight > 0"
  swallowed lobbed skirm rockets too — Recluse's missiles carry a 1.5-elmo
  hop. The exclusion became Cannon+trajectoryHeight, then a per-unit
  artillery census (because Firewalker's mortar has *no* trajectoryHeight
  and Merlin's rockets fly flat). Then four artillery units came back by
  design decision, with colours instead of a ban.
- **Sub-900-elmo special weapons were invisible.** Grizzly/Stinger/
  Detriment lasers and the Cyclops/Ogre guns sit under every generic
  gate; they are recorded through exact weapon-name overrides.

**Packer / daemon**

- **Test-run truncation math.** `--stop-after-game-min N` multiplied by
  30 frames… per *minute*, not per minute×60 — "first 10 minutes" stopped
  at 10 seconds. (Two error reports in `logs/errors/` still document the
  before/after.)
- **`testX` argument parsing** turned a missing number into NaN →
  `Math.max(1, NaN|0)` = 1 → "first 1 minute" silently.
- **Demo port binds.** Parallel resims of different demos collide on the
  port baked into their recordings; the first one wins and the rest die
  after their archive scan. The daemon now reports the bind failure
  explicitly and refuses to clobber the artifact (`*.cheap.zkr` instead).

**Viewer / model**

- **`trackAt` dropped fields mid-track.** Interpolation returned
  `{x,y,hp,bd,ck}` — no shield charge, cloak-field or stall bits — so
  every feature built on them (shield circles, bars, stall flash) was
  dead for ~100% of playback time while tests stayed green (they sampled
  exact track points). Now every sample field is carried.
- **Page model copies fields explicitly.** The engage rows decoded fine
  but never reached the page: `buildArtifactModel` had not been told
  about them, so the arrows existed and could not draw.
- **The morph feed lied three ways.** Pairing "unit died + unit spawned
  nearby" ignored the killer — a Sparrow shot down next to a Scan-Sweep
  LoS proxy read as "Sparrow morphed into LOS Provider" and hid two real
  kills from the grid. Killer gating + excluding `fakeunit_*` fixed it.
  Post-gameover cleanups read as "was cancelled"; commander morphs now
  read "morphed to level N" (dynXX digit + ZK's own display convention).
- **Wreck zones chained into mega-polygons** (transitive clustering put
  409 wrecks in one zone), and a `strokeStyle/lineWidth` leak painted
  every hull after the first black. Also: the zone chip was silently
  dead when "wrecks" was unchecked.
- **A staging-corner wreck filter deleted real wrecks.** A raw
  position-band filter (near map corners) erased three genuine Otago
  wrecks — a Jumpjet Factory among them — on a map with no silo at all.
  It is now gated on missile-unit deaths.
- **Votes**: the `endTm: -1` "unresolved" sentinel collided with
  genuinely negative times (pre-game polls pinned forever, feed line
  skipped); duplicate casts showed the same nick twice (autohosts count
  the last cast); the chat box was hard-anchored to the top on every
  content change, which read as "can't scroll".
- **Player-stat pairing.** The old hardcoded table misattributed elo
  values between players (Boetvaardig got WM1enjoyer's 566); the PSTA
  netmsg's `playerNum` is the truth, not the row index.
- **Icon incidents**: the antinuke icon was accidentally saved from the
  missile art (reverted); `nuke_missile.png` was committed upside-down
  (the DDS converter flips; that one file skipped it); the
  destination-out border trick hollowed the custom art's middle, so icon
  flights render solid-tinted now.
- **Cloak circles were ellipses** on wide maps: per-axis scaling had
  stretched them. One px/elmo scale + exact aspect fit fixed every
  circle layer at once.
- **The profiler lied twice before it told the truth**: segment labels
  were off by one (the "arrows" row was actually the unit icon loop), and
  the "N frames" header invited reading N as fps. It now states renderer
  fps, rAF rate and avg frame time separately — and those numbers exposed
  the real finding: the units layer dominates, and avg×fps ≈ one full
  core on the weak machine.
- **The stress replay broke the viewer's memory model.** The full Comet
  Catcher recording (15 MB artifact) OOMs at 8 GB — the object-per-sample
  decode does not scale to 25M samples. The 1 Hz experiment (`--pos-rate
  5`) proved data-density is the lever (same game, half the size, byte-
  identical flights/feed), and the typed-array decode is the planned
  proper fix.

**Process lessons that stuck**: adversarial counter-reviews after every
feature batch (several criticals were found exactly this way); verify on
real artifact bytes, not fixtures; headless page smokes before push; and
the profiler + diagnostics panels so the next argument is settled with
numbers instead of theories.

---

## Appendix — open-issue status as of this document

Completed by the merged work (candidates to close): #20, #21, #22
(antinuke/nuke/cruise-missile icons), #24 (antinuke coverage redesign),
#25, #30 (targets from game data), #31, #33 (launch/intercept
presentation + feed), #32 (in-browser profiling), #34 (separate
diagnostics feed).

Partially done / keep open: #29 (Comet resimmed, but parked off the site
until the typed-array decode lands — the artifact is currently
unloadable). Still open work: #35 (battle summary milestone), #36 (drone
spam in feed/graphs), #23 (controls UX pass), #27 (branch shortcuts),
#26 (localhost-first testing — now common practice, worth closing as
"adopted"), #10 (release housekeeping).
