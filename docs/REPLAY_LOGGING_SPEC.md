# Zero-K Web Replay — Logging Specification (`.zkr` v1)

Finalized logging contract for artifacts produced by the headless resim pipeline
(`spring-headless` + snapshot widget) and consumed by the web viewer.
Design basis: barreplay (mabn) sectioned-artifact format, adapted to Zero-K.

## 0. Artifact format

- One **`.zkr`** file per battle: sectioned binary, little-endian, each section
  independently zstd-compressed. Sections are optional and versioned via the
  header's schema version + per-section flags, so the reader can skip unknown
  data. Storage: `battles/{battleID}.zkr` in object storage, 7-day lifecycle,
  always regenerable from the permanent `.sdfz` demo.

| Section | Content | Default |
|---|---|---|
| `META` | schema version, gameID, demo sha256, engine+game versions, map (name/hash/dims), start time, winners, end condition | on |
| `ROSTER` | players, teams, allyteams, ELO, handicap, is-AI, commanders (modoptions loadouts), modoptions/mapoptions, startboxes, start positions | on |
| `UNITDEF` | embedded subset: defID → name, icon class, metal cost, hp | on |
| `WEAPONDEF` | defID → name, weaponType, color hint, keep-class (see §C) | on |
| `POS` | sampled unit positions (see §B) | on |
| `E` | unit lifecycle events (see §B) | on |
| `P` | projectile paths / beam lines (see §C) | on |
| `L` | special links — Djinn ⇄ Lamp (see §L) | on |
| `C` | chat (parsed straight from demo stream) | on |
| `D` | map drawings | on |
| `MACRO` | joins/leaves/pauses/resigns/team-died, game-over | on |
| `ECO` | per-team economy timeline (15 s cadence, from demo team-stats) | on |
| `DMG` | damage matrix + per-unit lifetime totals | off |
| `VIS` | per-team LOS/radar visibility per unit | off |

## A. Identity & metadata (`META`/`ROSTER`)

1. Artifact schema version (`.zkr` v1)
2. Source demo digest: 16-byte `gameID` + SHA-256 of the `.sdfz`
3. Engine version string (pinned resim version; resim refuses mismatches)
4. Game version string (`Zero-K vX.Y.Z`, rapid tag)
5. Map name, map hash, map dimensions (game units → viewport scale)
6. Start unix time, wallclock-vs-gametime ratio
7. Winners (allyteam IDs) + end condition (annihilation / resign / quit)
8. Roster: playerID, name, lobbyID, faction, team, allyteam, spectator, ELO, handicap, is-AI
9. Commander loadouts (names, chassis, weapons, modules from `modoptions`)
10. Startboxes; chosen start positions
11. Full `modoptions` / `mapoptions` dump

## B. Unit lifecycle & sampled state (`POS`/`E`)

12. Spawn: `(frame, unitID, defID, team, x, z, heading, builderID)`
13. Finished (construction complete)
14. **Probe every 0.2 s (every 6th frame @ 30 fps):** `x int16, z int16,
    hpFrac uint8, buildProgress uint8` — int16 quantized across map width,
    delta-encoded per unit, zstd.
    Capture is always 0.2 s; the **packer** flag `--pos-rate` may downsample
    (default 1) only when artifact size exceeds the ceiling (target ≤ 10 MB).
15. Morph/upgrade: old defID → new defID
16. Transfer: `(unitID, fromTeam, toTeam)` — gifted / captured / died-capture
17. Death: `(unitID, frame, cause [killed, shot, selfd, captured, crash,
    collapse], killerTeam, killerUnitID, weaponDefID)` — arguments taken from
    the engine callins at source (wrappers may drop attacker/projectile info)

## C. Projectiles (`P`) — revised policy

Classifier runs at resim time from weaponDefs (`weaponType`, `range`,
`trajectoryHeight`, `customParams`). Buckets:

**Dropped** (no path, no line):
- `AircraftBomb` — napalm/prec/riot bomber drops, chicken Dodo/Spores
  (range ≈ 0–500, sub-second drop; kill side-effects already in `E`)
- `Melee`, `Shield`, `LightningCannon`
- `TorpedoLauncher` (default off — short underwater arcs; flag to enable)
- Junk/utility by name or customParams: "Fake Bomb", "Bogus Teleport Target",
  ANL fakes, `raveparty` party cannons

**Beam lines** (origin → impact line, no arc sampling; `BeamLaser`/`LaserCannon`
with `range ≥ 900`):
- `mahlazer` LRPC (10000), `starlight_satellite` Groovecutter (10500),
  `zenith` Meteor (8800–20000), `hoverarty` Tachyon Accelerator (980)

**Artillery arcs** (full 8 Hz trajectory, int16 quantized; `Cannon` with
`range ≥ 1000`, or gravity-affected (`trajectoryHeight > 0`) with `range ≥ 800`):
- `shipheavyarty` Long-Range Plasma Battery (1600), `vehheavyarty` Kinetic
  Missile (1500), `tankheavyarty` Rapid-Fire Plasma Artillery (1160),
  `tankarty` Plasma Artillery (1150), static/turret plasma artillery

**Missile paths** (full 8 Hz trajectory; `StarburstLauncher`/`MissileLauncher`
with `range ≥ 900`, or commander-scale payload flags in customParams):
- `staticnuke` Strategic Nuclear Missile (silo nuke, 72000) — dedicated flag
  `isNuke`, impact renders as signature blast
- `tacnuke` / `subtacmissile` Tactical Nuke (3500), `empmissile` (3500),
  `napalmmissile` (3500), `missileslow`/`seismic` (6000),
  `shieldarty` Disarm Cruise Missile (940), `striderarty` Rocket Battery (1450)

**Interceptor events** (`staticantinuke` anti-nuke, and other interceptors on
recorded trajectories): log the launch and interception *events* only — no
path. Interception = the moment an incoming nuke/missile dies with
`killerUnitID` = interceptor.

Explosion markers for area weapons (weaponDefID + position): on.

## D. Macro events (`C`/`D`/`MACRO`)

- Chat: `(frame, playerID, dest public/ally, text)` — no resim needed
- Map drawings: lines / points / erase, labels
- Player joins/leaves, spectator joins, reconnects
- Pause/unpause intervals, game-speed changes
- Resigns, "give away everything", team-died
- Player action counts per interval (APM curve, from demo COMMAND messages)
- Sync-error marker (only if resim detects checksum deviation)

## E. Aggregates (pack-time)

- Per-team economy timeline (metal/energy produced/used/received/sent, 15 s
  cadence — straight from demo team-stats; note: autohost demos may omit these,
  fall back to "not recorded")
- Per-unit lifetime damage totals, damage matrix (`DMG` flag)
- Fight clusters / kill heatmap, highlight frames (first blood, biggest 10 s of
  deaths, game-deciding push) — tag-only, cheap

## L. Special links — Djinn ⇄ Lamp

`units/amphtele.lua` (**Djinn**) deploys `units/tele_beacon.lua` (**Lamp**) as
its teleport target. When a Lamp is created and its builder is a Djinn, log:

```
L (frame, djinnID, lampID, team, lampX, lampZ)
LX (frame, lampID)   // Lamp destroyed/moved → link ends
```

Viewer draws a **dash-dot-dash** polyline (`— · —`) from Djinn to Lamp in the
lamp's team colour while both are alive and the link is open. Multiple Lamps
per Djinn and multiple Djinns per team are supported (link by `builderID` at
creation time; overlap draws go to the most recent pair).

## F. Encoding summary

- Coordinates: int16 map-space (map width = 65536 units), delta-encoded
- HP / progress: uint8 fractions
- Sample cadence: 0.2 s capture (6 frames @ 30 fps); packer may downsample
- Compression: per-section zstd; overall target ≤ 10 MB, hard ceiling 16 MB

## Packer flags

| Flag | Default | Effect |
|---|---|---|
| `--pos-rate` | 1 (0.2 s) | position sample cadence multiplier |
| `--projectiles preset` | `heavy` | `none` / `beams` / `heavy` (beams+arty+missiles) / `all` |
| `--damage-matrix` | off | adds `DMG` |
| `--visibility` | off | adds `VIS` |
| `--torpedoes` | off | record torpedo arcs |
