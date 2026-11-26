/**
 * Viewer parity tests — the browser decoder (mockup/replay.js) must recover
 * what src/daemon/pack.ts encodes, byte-for-byte.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildZkrFromResim } = require("../dist/daemon/pack.js");
const { readZkr } = require("../dist/zkr/container.js");
require("../mockup/replay.js");
const ZkrReplay = globalThis.ZkrReplay;

function syntheticSnapshot() {
  return {
    meta: { mapW: 16384, mapH: 16384, engine: "test" },
    units: new Map([
      [1, { unitID: 1, defID: 10, samples: [
        { frame: 6, x: 1024.5, z: 2048.25, hp: 230, build: 255 },
        { frame: 12, x: 1124.5, z: 2148.25, hp: 204, build: 255 },
        { frame: 18, x: 1224.5, z: 2248.25, hp: 179, build: 255 },
      ] }],
      [2, { unitID: 2, defID: 11, samples: [
        { frame: 6, x: 4096, z: 8192, hp: 255, build: 255 },
      ] }],
    ]),
    unitDefs: new Map(),
    weaponDefs: new Map([
      [7, { defID: 7, name: "nuke_missile", type: "StarburstLauncher", range: 6000 }],
    ]),
    events: [
      { kind: "spawn", frame: 6, unitID: 1, int1: 10, int2: 0, int3: -1 },
      { kind: "spawn", frame: 6, unitID: 2, int1: 11, int2: 1, int3: -1 },
      // a morph SELF-destructs its victim: no killer is attributed
      { kind: "death", frame: 900, unitID: 2, int1: -1, int2: 0, int3: 42 },
    ],
    projectiles: new Map([
      [100, { proID: 100, weaponDefID: 7, projClass: 3, ownerTeam: 0, startFrame: 6,
        samples: [{ x: 8192, z: 4096, y: 100 }, { x: 8196, z: 4100, y: 150 }] }],
    ]),
    links: new Map([]),
    gameOvers: [{ frame: 1500, winners: [0] }],
  };
}

test("viewer decoder recovers unit tracks from a packed artifact", async () => {
  const snap = syntheticSnapshot();
  const zkr = buildZkrFromResim(snap, { projectiles: "heavy" });
  const artifact = await ZkrReplay.parse(new Uint8Array(Buffer.from(zkr)));
  assert.equal(artifact.pos.units.length, 2);
  const u1 = artifact.pos.units.find((u) => u.unitID === 1);
  assert.equal(u1.defID, 10);
  assert.equal(u1.samples.n, 3);
  assert.ok(Math.abs(u1.samples.x[0] - 1024.5 / 16384) < 0.001);
  assert.ok(Math.abs(u1.samples.y[2] - 2248.25 / 16384) < 0.001);
  assert.ok(Math.abs(u1.samples.hp[0] / 255 - 0.9) < 0.01);
  assert.equal(artifact.evnt.records[2].kind, "death");
  assert.equal(artifact.proj.paths[0].cls, 3);
});

test("startbox parser reads ROST lua startboxes, tolerant of sci notation", () => {
  const boxes = ZkrReplay.parseStartboxes([
    { startboxes: "return { [0]={x1=0.1,z1=0.2,x2=0.9,z2=0.4}, [1]={x1=1e-1,z1=2e-1,x2=9e-1,z2=4e-1} };" },
    {},
  ]);
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0]!.length, 2);
  assert.equal(boxes[0]![0]!.x1, 0.1);
  assert.equal(boxes[0]![0]!.z2, 0.4);
  assert.equal(boxes[0]![1]!.x2, 0.9);
  assert.equal(boxes[1]!.length, 0);
});

test("feed falls back to ids and team numbers without ROST/UDEF data", async () => {
  const snap = syntheticSnapshot();
  // the fixture's morph victim self-destructs; this test wants a KILL line
  snap.events[2] = { kind: "death", frame: 900, unitID: 2, int1: 1, int2: 0, int3: 42 };
  const zkr = buildZkrFromResim(snap, { projectiles: "heavy" });
  const artifact = await ZkrReplay.parse(new Uint8Array(Buffer.from(zkr)));
  const model = ZkrReplay.artifactToModel(artifact);
  assert.equal(model.feedData.length, 1);
  assert.equal(model.feedData[0]!.txt, "Unit #2 destroyed — killed by Unit #1 (Team 1)");
  assert.equal(model.winnerLabel, "Team 1");
  assert.deepEqual(model.startPolys, []);
});

test("STBX engine polygons override startscript rects in the model", async () => {
  const snap = syntheticSnapshot();
  snap.startboxes = {
    allyBox: [[0, 1], [1, 0]],
    boxes: new Map([
      [0, [[[0.86, 0.34], [0.96, 0.34], [0.96, 0.66], [0.86, 0.66]]]],
      [1, [[[0.04, 0.34], [0.12, 0.34], [0.12, 0.6], [0.04, 0.6]]]],
    ]),
  };
  const zkr = buildZkrFromResim(snap, { projectiles: "heavy" });
  const artifact = await ZkrReplay.parse(new Uint8Array(Buffer.from(zkr)));
  const model = ZkrReplay.artifactToModel(artifact);
  assert.equal(model.startPolys.length, 2);
  assert.equal(model.startPolys[0]![0]![0]![0]!, 0.04);
  assert.equal(model.startPolys[1]![0]![0]![0]!, 0.86);
  /* without STBX, rects from the startscript become polygons */
  const snap2 = syntheticSnapshot();
  const zkr2 = buildZkrFromResim(snap2, { projectiles: "heavy" });
  const model2 = ZkrReplay.artifactToModel(await ZkrReplay.parse(new Uint8Array(Buffer.from(zkr2))));
  assert.deepEqual(model2.startPolys, []);
});

test("startbox parser handles bundled modoptions blobs and positional boxes", () => {
  const boxes = ZkrReplay.parseStartboxes([], {
    startboxes: "return { [0]={ [0]={0.1,0.2,0.3,0.4} }; [1]={ [0]={1e-1,5e-1,7e-1,8e-1} }; };",
  });
  assert.equal(boxes.length, 2);
  assert.deepEqual(boxes[0], [{ x1: 0.1, z1: 0.2, x2: 0.3, z2: 0.4 }]);
  assert.deepEqual(boxes[1], [{ x1: 0.1, z1: 0.5, x2: 0.7, z2: 0.8 }]);
  /* empty blob (game without startboxes) -> nothing drawn */
  assert.deepEqual(ZkrReplay.parseStartboxes([], { startboxes: "return { }" }), []);
});

test("team colours key off allyteam teams, feed/chat use human names", () => {
  const artifact = {
    roster: {
      players: [
        { name: "A", team: 0, spectator: false, script: "player0" },
        { name: "B", team: 1, spectator: false, script: "player1" },
      ],
      teams: [{ num: 0, allyteam: 0 }, { num: 1, allyteam: 1 }],
    },
    unitDefs: { units: [[5, "cloakraid", 65, 230, 1, "kbotraider", "Glaive"]] },
    evnt: { records: [
      { kind: "spawn", frame: 6, unitID: 10, int1: 5, int2: 0, int3: -1 },
      { kind: "death", frame: 90, unitID: 10, int1: -1, int2: 1, int3: -1 },
    ] },
    chat: [
      [30, 0, 254, "hello all"],
      [60, 0, 252, "hello team"],
      [90, 1, 253, "hello specs"],
      [120, 0, 1, "psst"],
      [150, 255, 254, "SPRINGIE:READY:A"],
    ],
  };
  const model = ZkrReplay.artifactToModel(artifact);
  assert.equal(model.feedData[0]!.txt, "Glaive destroyed (B)");
  assert.equal(model.teamMeta[0]!.ally, 0);
  assert.equal(model.teamMeta[1]!.ally, 1);
  assert.notEqual(ZkrReplay.teamColor(0, model.teamMeta), ZkrReplay.teamColor(1, model.teamMeta));
  const chat = model.chatData;
  assert.deepEqual(chat.map((c) => c.kind), ["all", "team", "spec", "whisper"]);
  assert.equal(chat[0]!.name, "A");
  assert.equal(chat[3]!.name, "A");
  assert.deepEqual(chat.map((c) => c.txt).includes("SPRINGIE:READY:A"), false);
});

test("viewer decoder accepts Node-packed buffers (roundtrip parity)", () => {
  const snap = syntheticSnapshot();
  const zkr = buildZkrFromResim(snap, { projectiles: "heavy" });
  const secs = readZkr(zkr);
  assert.ok(secs.find((s) => s.id === "POS "));
  assert.ok(secs.find((s) => s.id === "EVNT"));
  assert.ok(secs.find((s) => s.id === "PROJ"));
});

test("health ring baseline: units carry hpMax and only true damage shows the ring", async () => {
  const zkr = buildZkrFromResim(syntheticSnapshot(), { projectiles: "heavy" });
  const artifact = await ZkrReplay.parse(new Uint8Array(Buffer.from(zkr)));
  const model = ZkrReplay.artifactToModel(artifact);
  const hurt = model.units.find((u) => u.id === 1)!;
  const full = model.units.find((u) => u.id === 2)!;
  assert.ok(hurt.hpMax !== undefined, "tracked unit must expose hpMax");
  assert.ok(hurt.hpMax! - hurt.track.hp[hurt.track.n - 1] / 255 > 0.002,
    "unit 1 ends below its peak, so the ring would draw");
  assert.equal(full.hpMax!, 1);
  assert.ok(full.hpMax! - full.track.hp[0] / 255 <= 0.002,
    "unit 2 sits at its peak, so the ring stays hidden");
});

test("viewer model recovers winner, gameover and interpolated positions", async () => {
  const zkr = buildZkrFromResim(syntheticSnapshot(), { projectiles: "heavy" });
  const artifact = await ZkrReplay.parse(new Uint8Array(Buffer.from(zkr)));
  const gameover = artifact.evnt.records.find((r) => r.kind === "gameover");
  assert.ok(gameover, "EVNT must carry a gameover row");
  assert.equal(gameover.int1, 0);
  const model = ZkrReplay.artifactToModel(artifact);
  assert.equal(model.winner, 0);
  assert.ok(model.hasUnits);
  assert.equal(model.END, 1500 / 30);
  const u1 = model.units.find((u) => u.id === 1)!;
  assert.ok(Math.abs(u1.track.x[0]! - 1024.5 / 16384) < 0.001);
  // sample timing is true frames now (POS v2): samples sit at 6/12/18 frames
  // (0.2/0.4/0.6 s); interpolating mid-segment at frame 9 lands halfway
  const mid = ZkrReplay.trackAt(u1.track, 9 / 30);
  assert.ok(Math.abs(mid!.x - (1024.5 + 1124.5) / 2 / 16384) < 0.001);
  const late = ZkrReplay.trackAt(u1.track, 10.5 / 30); // f = 0.75 -> later probe
  assert.ok(Math.abs(late!.hp - 0.8) < 0.02, `hp steps toward the later probe (got ${late!.hp})`);
});

test("allyteam palettes: green->cyan->blue vs red->orange->brown, lightness-aware separation", () => {
  /* allyteam 0 walks green -> cyan -> blue, allyteam 1 red -> orange -> brown;
     lightness zigzags so every teammate pair stays separable (dE not hue-only) */
  const c0 = ZkrReplay.teamColor(0, { 0: { ally: 0, idx: 0, n: 4 } })!;
  const c3 = ZkrReplay.teamColor(0, { 0: { ally: 0, idx: 3, n: 4 } })!;
  assert.match(c0, /hsl\(\d+,\d+%,\d+%\)/);
  assert.notEqual(c0, c3);
  // across the ramp lightness must vary (not a fixed-lightness hue strip),
  // and no stop may approach black ("bright ... but not so dark")
  const lights = [0, 3, 6, 9, 12, 15].map((i) =>
    Number(ZkrReplay.TEAL16[i]!.match(/hsl\(\d+,\d+%,(\d+)%\)/)![1]));
  assert.ok(Math.max(...lights) - Math.min(...lights) >= 15, "lightness zigzags on the teal ramp");
  assert.ok(Math.min(...lights) >= 30, "teal ramp never gets near-black");
  const warmLights = [0, 3, 6, 9, 12, 15].map((i) =>
    Number(ZkrReplay.WARM16[i]!.match(/hsl\(\d+,\d+%,(\d+)%\)/)![1]));
  assert.ok(Math.max(...warmLights) - Math.min(...warmLights) >= 15, "lightness zigzags on the warm ramp");
  assert.ok(Math.min(...warmLights) >= 25, "warm ramp never gets near-black");
  // two teammates of the same allyteam share the hue family but differ in colour
  const a = ZkrReplay.teamColor(0, { 0: { ally: 0, idx: 0, n: 3 } })!;
  const b = ZkrReplay.teamColor(0, { 0: { ally: 0, idx: 1, n: 3 } })!;
  const c = ZkrReplay.teamColor(0, { 0: { ally: 0, idx: 2, n: 3 } })!;
  assert.notEqual(a, b); assert.notEqual(b, c); assert.notEqual(a, c);
});

test("hp ring colour follows the green->orange->red gradient", () => {
  const c = (hp: number) => ZkrReplay.hpColor(hp);
  assert.match(c(1)!, /hsl\(135,/);   // full health: vibrant green
  assert.match(c(0.6)!, /hsl\(32,/);  // 60%: orange
  assert.match(c(0)!, /hsl\(5,/);     // 0%: deep bright red
  const a = Number(c(0.8)!.match(/hsl\((\d+)/)![1]);
  const b = Number(c(0.7)!.match(/hsl\((\d+)/)![1]);
  assert.ok(a > b, "hue decreases as hp drops");
  assert.equal(c(null), "#9aa4aa");   // unknown hp keeps the neutral grey
});

test("POS v3 keeps true sample timing (probe gaps), cloak/field bits and shield charge", async () => {
  // irregular gaps are the point: v1 threw the cadence away and decoders
  // wrongly assumed one sample per frame, compressing unit motion to 1/6
  const snap = syntheticSnapshot();
  const u = snap.units.get(1)!;
  u.samples = [
    { frame: 6, x: 1024.5, z: 2048.25, hp: 255, build: 255, cloaked: true, cloakField: true, shield: 1 },
    { frame: 13, x: 1090, z: 2100, hp: 255, build: 255, cloaked: true, cloakStalled: true, shield: 0.5 },
    { frame: 25, x: 1200, z: 2200, hp: 255, build: 255, cloaked: true, cloakField: true },
  ];
  snap.unitDefs = new Map([
    [10, { defID: 10, name: "shieldshield", humanName: "Aspis", metalCost: 900, health: 2500, canMove: true, iconType: "walkershield", cloakRadius: -1, shieldRadius: 350, shieldPower: 3600 }],
  ]);
  const zkr = buildZkrFromResim(snap, { projectiles: "heavy" });
  const artifact = await ZkrReplay.parse(new Uint8Array(Buffer.from(zkr)));
  assert.equal(artifact.pos.version, 3);
  const posUnit = artifact.pos!.units.find((x) => x.unitID === 1)!;
  /* decoded samples are COLUMNAR: t seconds (frames = t*30), flag bits in
     fl (bit0 cloak, bit1 field, bit2 stall), raw shield byte 255=unknown */
  const sm = posUnit.samples;
  assert.deepEqual(Array.from(sm.t).map((v) => Math.round(v * 30)), [6, 13, 25]);
  assert.deepEqual(Array.from(sm.fl).map((f) => (f & 1) !== 0), [true, true, true]);
  assert.deepEqual(Array.from(sm.fl).map((f) => (f & 2) !== 0), [true, false, true]);
  assert.deepEqual(Array.from(sm.fl).map((f) => (f & 4) !== 0), [false, true, false]);
  // shield charge byte round-trips at 0..254 resolution, 255 = no shield
  const sh = (i: number) => (sm.sh[i] === 255 ? undefined : sm.sh[i]! / 254);
  assert.ok(Math.abs(sh(0)! - 1) < 0.01);
  assert.ok(Math.abs(sh(1)! - 0.5) < 0.01);
  assert.equal(sh(2), undefined, "no shield recorded -> undefined, not 0");
  const model = ZkrReplay.artifactToModel(artifact);
  const m = model.units.find((x) => x.id === 1)!;
  assert.deepEqual(Array.from(m.track.t).map((v) => Math.round(v * 30)), [6, 13, 25]);
  assert.equal(m.shieldRadius, 350, "UDEF v3 shield radius reaches the model");
  assert.equal(m.shieldPower, 3600);
  assert.deepEqual(Array.from(m.track.fl).map((f) => (f & 4) !== 0), [false, true, false]);
  // C1 regression: probes are 6 frames apart, so nearly every rendered
  // frame interpolates — the state bits must survive trackAt mid-sample
  // (samples sit at 0.2/0.433/0.833 s; 0.3 is strictly between the first two)
  const mid = ZkrReplay.trackAt(m.track, 0.3);
  assert.ok(mid.sh !== undefined && Math.abs(mid.sh! - 1) < 0.01,
    "shield charge survives interpolation (was dropped before the counter-review fix)");
  assert.equal(mid.cf, true);
  assert.equal(mid.cs, false);
  const mid2 = ZkrReplay.trackAt(m.track, 0.5);
  assert.equal(mid2.cs, true, "mid-way to sample 2 picks up the stalled bit");
});

test("shield colour lerp matches ZK's shieldGoodColor/shieldBadColor", () => {
  assert.equal(ZkrReplay.shieldColor(1), "rgb(26,26,255)");
  assert.equal(ZkrReplay.shieldColor(0), "rgb(255,26,26)");
  assert.equal(ZkrReplay.shieldColor(0.5), "rgb(141,26,141)", "midpoint is a smooth 50% mix");
  assert.equal(ZkrReplay.shieldColor(-3), ZkrReplay.shieldColor(0), "clamped low");
  assert.equal(ZkrReplay.shieldColor(9), ZkrReplay.shieldColor(1), "clamped high");
  assert.equal(ZkrReplay.shieldColor(0.5, 0.2), "rgba(141,26,141,0.2)", "alpha form for the field circle");
});

test("wreck features pack/decode: reclaimed wrecks disappear, metal kept", async () => {
  const snap = syntheticSnapshot();
  // a fencer wreck at frame 900, reclaimed again at frame 1500
  snap.events.push(
    { kind: "wreck", frame: 900, unitID: 90001, int1: 88, int2: 3072, int3: 6144 },
    { kind: "unwreck", frame: 1500, unitID: 90001, int1: -1, int2: -1, int3: -1 },
  );
  const zkr = buildZkrFromResim(snap, { projectiles: "heavy" });
  const artifact = await ZkrReplay.parse(new Uint8Array(Buffer.from(zkr)));
  assert.ok(artifact.evnt.records.some((r) => r.kind === "wreck"), "wreck kind survives the pack");
  const model = ZkrReplay.artifactToModel(artifact);
  assert.equal(model.wrecks.length, 1, "engine-recorded wrecks replace the death fallback");
  const w = model.wrecks[0]!;
  assert.ok(Math.abs(w.born - 30) < 1e-6);
  assert.ok(Math.abs(w.gone - 50) < 1e-6);
  assert.equal(w.metal, 88);
  assert.ok(Math.abs(w.x - 3072 / 16384) < 1e-6);
});

test("no wreck records: wrecks fall back to death positions and 40% metal", async () => {
  const snap = syntheticSnapshot();
  snap.unitDefs = new Map([
    [11, { defID: 11, name: "fencer", humanName: "Fencer", metalCost: 220, health: 900, canMove: true, iconType: "moduleshare" }],
  ]);
  const zkr = buildZkrFromResim(snap, { projectiles: "heavy" });
  const artifact = await ZkrReplay.parse(new Uint8Array(Buffer.from(zkr)));
  const model = ZkrReplay.artifactToModel(artifact);
  // unit 2 dies at frame 900 (fixture); its last sample is at (4096, 8192)
  assert.equal(model.wrecks.length, 1);
  const w = model.wrecks[0]!;
  assert.ok(Math.abs(w.born - 30) < 1e-6);
  assert.equal(w.metal, 88, "220 metal x 0.4 reclaim estimate");
  assert.equal(w.gone, -1, "unrecorded wrecks never disappear");
  // u16 position quantization: 1/65535 granularity
  assert.ok(Math.abs(w.x - 4096 / 16384) < 1e-4 && Math.abs(w.y - 8192 / 16384) < 1e-4);
});

test("legacy POS v2 decodes cloaked but leaves the field bit undefined (fallback to ck)", async () => {
  // hand-pack a v2 POS section exactly as the PR #12 packer wrote it
  // (s16 dX, s16 dZ, s16 frameDelta, u8 hp, u8 build, u8 flags = bit0)
  const b = Buffer.alloc(64);
  let o = 0;
  b.writeUInt32LE(1, o); o += 4;                      // numUnits
  b.writeUInt32LE(5, o); o += 4;                     // unitID
  b.writeUInt16LE(10, o); o += 2;                    // defID
  b.writeUInt32LE(100, o); o += 4;                   // firstFrame
  b.writeUInt16LE(2, o); o += 2;                     // sampleCount
  b.writeUInt16LE(0, o); o += 2;                      // originX
  b.writeUInt16LE(0, o); o += 2;                      // originZ
  for (let k = 0; k < 2; k++) {
    b.writeInt16LE(10, o); o += 2;                   // dX
    b.writeInt16LE(5, o); o += 2;                    // dZ
    b.writeInt16LE(6, o); o += 2;                     // frameDelta
    b.writeUInt8(255, o); o += 1;                      // hp
    b.writeUInt8(255, o); o += 1;                      // build
    b.writeUInt8(k === 0 ? 1 : 3, o); o += 1;          // flags: bit0, v2's bit1 is garbage
  }
  const { writeZkr } = require("../dist/zkr/container.js");
  const zkr = writeZkr([{ id: "POS ", version: 2, payload: new Uint8Array(b.subarray(0, o)), codec: 1 }]);
  const artifact = await ZkrReplay.parse(new Uint8Array(Buffer.from(zkr)));
  const s = artifact.pos!.units[0]!.samples;
  /* decoded track is COLUMNAR (typed arrays): flags in fl bits, semantics
     (ck/cf/cs/sh) via trackAt / trackSample */
  assert.deepEqual(Array.from(s.fl).map((f) => (f & 1) !== 0), [true, true]);
  const s0 = ZkrReplay.trackAt(s, s.t[0])!, s1 = ZkrReplay.trackAt(s, s.t[1])!;
  assert.deepEqual([s0.cf, s1.cf], [undefined, undefined],
    "v2 bit1 is NOT a field bit: pre-#13 artifacts would lose all field circles if read");
  const model = ZkrReplay.artifactToModel(artifact);
  const m = model.units[0]!;
  assert.deepEqual([s0.cf, s1.cf], [undefined, undefined]);
  /* v2 carries no shield byte either: sh must read as undefined, never 0
     (a zero would paint every pre-v3 shield unit as fully drained) */
  assert.deepEqual([s0.sh, s1.sh], [undefined, undefined],
    "v2 trackAt shield reads undefined, not a drained 0");
});

test("legacy POS v1 decodes with the widget's 6-frame probe cadence", async () => {
  // hand-pack a v1 POS section exactly as the old packer wrote it
  // (s16 dX, s16 dZ, u8 hp, u8 build per sample)
  const b = Buffer.alloc(64);
  let o = 0;
  b.writeUInt32LE(1, o); o += 4;                      // numUnits
  b.writeUInt32LE(5, o); o += 4;                     // unitID
  b.writeUInt16LE(10, o); o += 2;                    // defID
  b.writeUInt32LE(100, o); o += 4;                   // firstFrame
  b.writeUInt16LE(3, o); o += 2;                     // sampleCount
  b.writeUInt16LE(0, o); o += 2;                     // originX
  b.writeUInt16LE(0, o); o += 2;                     // originZ
  for (let k = 0; k < 3; k++) {
    b.writeInt16LE(10, o); o += 2;                   // dX
    b.writeInt16LE(5, o); o += 2;                    // dZ
    b.writeUInt8(255, o); o += 1;                    // hp
    b.writeUInt8(255, o); o += 1;                    // build
  }
  const { writeZkr } = require("../dist/zkr/container.js");
  const zkr = writeZkr([{ id: "POS ", version: 1, payload: new Uint8Array(b.subarray(0, o)), codec: 1 }]);
  const artifact = await ZkrReplay.parse(new Uint8Array(Buffer.from(zkr)));
  const s = artifact.pos!.units[0]!.samples;
  assert.deepEqual(Array.from(s.t).map((v) => Math.round(v * 30)), [100, 106, 112],
    "v1 artifacts must decode at the historical probe cadence, not one-per-frame");
});

test("artifactToModel anchors DEMO data at STARTPLAYING, keeps resim on the play clock", () => {
  /* Two clocks: resim sections (POS/EVNT) are engine play frames - frame 0
     IS play start. Demo-derived rows (CHAT/ECO) are absolute demo frames
     including the lobby/pick phase; MACR.startPlayingFrame is where play
     begins. Only demo data gets shifted. (Found by adversarial review:
     naive global shifting erased the game's first 160 s.) */
  const artifact = {
    containerVersion: 1, sections: [],
    meta: { schema: 1, gameTime: 160, map: { name: "Otago 1.4", dims: [16384, 16384] } },
    macro: { startPlayingFrame: 4799 },
    roster: { players: [], teams: [], allyteams: [], modoptions: null },
    unitDefs: { units: [[89, "cloakjammer", 600, 600, 1, "kbotjammer", "Iris", 350]] },
    weaponDefs: null, chat: [
      [4, 255, 254, "User KetchupStreamer joined the battle"],
      [483, 6, 252, "I choose: Ninse Prenchence!"],
      [4900, 6, 254, "gl hf"],
    ],
    eco: null, psta: null, link: null, proj: null,
    evnt: {
      records: [
        { kind: "spawn", frame: 4810, unitID: 1, int1: 89, int2: 0, int3: -1 },
        { kind: "death", frame: 4845, unitID: 1, int1: -1, int2: -1, int3: -1 },
        { kind: "gameover", frame: 4900, unitID: -1, int1: 0, int2: 1, int3: -1 },
      ],
      maxFrame: 4900,
    },
    pos: {
      units: [{
        unitID: 1, defID: 89, firstFrame: 4810,
        /* columnar track, as decodePos emits (t seconds, fl bits, raw u8s) */
        samples: {
          n: 2, v3: true,
          t: new Float32Array([4810 / 30, 4840 / 30]),
          x: new Float32Array([0.5, 0.5]),
          y: new Float32Array([0.5, 0.5]),
          hp: new Uint8Array([255, 255]),
          bd: new Uint8Array([255, 255]),
          fl: new Uint8Array([1, 0]),
          sh: new Uint8Array([255, 255]),
        },
      }],
      maxFrame: 4840,
    },
  };
  const model = ZkrReplay.artifactToModel(artifact as never);
  // resim units stay on the play clock: born/died are raw frames / 30
  const u = model.units.find((x) => x.id === 1)!;
  assert.ok(Math.abs(u.born - 4810 / 30) < 1e-6, `resim born must stay unshifted (got ${u.born})`);
  assert.ok(Math.abs(u.died - 4845 / 30) < 1e-6, "died unshifted too");
  // demo chat is anchored: pick-phase rows land <= 0 and are tagged pre
  assert.equal(model.chatData.filter((c) => c.pre).length, 2);
  assert.ok(model.chatData[0]!.tm <= 0, "lobby chat at or before 0");
  assert.ok(Math.abs(model.chatData[2]!.tm - 101 / 30) < 1e-6, "in-game chat shifted by the anchor");
  // END is the play clock: max(resim frames, META.gameTime), never anchored
  assert.equal(model.END, 4900 / 30);
  assert.equal(model.pregameSec, 4799 / 30);
  // cloak: Iris radius + a cloaked sample propagate
  assert.equal(u.cloakRadius, 350);
  assert.equal((u.track.fl[0]! & 1) !== 0, true);
  // map dims for circle scaling
  assert.equal(model.mapW, 16384);
  assert.equal(model.mapH, 16384);
});

test("parseDemoStream anchors at the STARTPLAYING with its countdown elapsed", () => {
  const { parseDemoStream } = require("../dist/demo/stream.js");
  // chunk layout: [f32 modGameTime][u32 length][type u8][payload]
  const chunk = (mt, type, payload = Buffer.alloc(0)) => {
    const head = Buffer.alloc(8);
    head.writeFloatLE(mt, 0);
    head.writeUInt32LE(1 + payload.length, 4);
    return Buffer.concat([head, Buffer.of(type), payload]);
  };
  // ZK reality: first STARTPLAYING carries a u32 ms countdown, second is 0
  const countdown = Buffer.alloc(4);
  countdown.writeUInt32LE(4000, 0);
  const buf = Buffer.concat([
    chunk(159.969, 4, countdown),  // playing "begins in 4000 ms"
    chunk(163.942, 4),             // countdown elapsed -> play starts
    chunk(200, 7, Buffer.of(7, 254, 0x68, 0x69, 0x00)), // a chat msg
  ]);
  const res = parseDemoStream(buf, { demoStreamSize: buf.length }, { keepChunks: true });
  // the anchor must be the LATEST candidate: 4918 + 0, not 4799 + 120 === 4919
  assert.equal(res.startPlayingFrame, Math.max(4799 + 120, 4918));
  assert.equal(res.chat.length, 1);
});

test("damageShade: full hp keeps the exact colour, dead keeps each channel at 50%", () => {
  const col = "hsl(120, 100%, 50%)"; // pure green
  assert.equal(ZkrReplay.damageShade(col, 1), "rgb(0,255,0)");
  assert.equal(ZkrReplay.damageShade(col, 0), "rgb(0,128,0)"); // 0.5 * 255
  const half = ZkrReplay.damageShade(col, 0.5); // k = 0.75
  assert.equal(half, "rgb(0,191,0)");
  // hp clamp + passthrough of unparseable colours / absent hp
  assert.equal(ZkrReplay.damageShade(col, 5), "rgb(0,255,0)");
  assert.equal(ZkrReplay.damageShade(col, -3), "rgb(0,128,0)");
  assert.equal(ZkrReplay.damageShade("rgb(12,34,56)", 0), "rgb(12,34,56)");
  assert.equal(ZkrReplay.damageShade(col, undefined), col);
  // hex form (spectator grey) shades too
  assert.equal(ZkrReplay.damageShade("#9aa4aa", 0), "rgb(77,82,85)", "each channel at 50%");
});

test("damageShade quantizes hp to 16 steps (bounds the icon tint cache)", () => {
  const col = "hsl(120, 100%, 50%)";
  // 0.37 is not on a 16th boundary: it rounds to 6/16 = 0.375
  assert.equal(ZkrReplay.damageShade(col, 0.37), ZkrReplay.damageShade(col, 0.375));
  assert.notEqual(ZkrReplay.damageShade(col, 0.31), ZkrReplay.damageShade(col, 0.375), "a different 16th must shade differently");
  const distinct = new Set<string>();
  for (let hp = 0; hp <= 1.0001; hp += 0.01) distinct.add(ZkrReplay.damageShade(col, hp));
  assert.equal(distinct.size, 17, "exactly one shade per 16th plus full hp keeps the cache bounded");
});

test("damageShade matches hslToRgb scaled channels (random spot checks)", () => {
  for (const hue of [4, 32, 130, 206, 342]) {
    for (const l of [0.32, 0.55, 0.82]) {
      const src = "hsl(" + hue + ",88%," + Math.round(l * 100) + "%)";
      const hp = 0.37; // quantizes to 6/16
      const got = ZkrReplay.damageShade(src, hp);
      const expect = ZkrReplay.hslToRgb(hue, 0.88, l)
        .map((v) => Math.round(v * (0.5 + 0.5 * 0.375)));
      assert.equal(got, "rgb(" + expect.join(",") + ")");
    }
  }
});

test("terraform helper units never reach the model (units or feed)", async () => {
  const snap = syntheticSnapshot();
  // a terraunit: spawned, probed, and destroyed by unit 1
  snap.unitDefs = new Map([
    [10, { defID: 10, name: "fencer", humanName: "Fencer", metalCost: 220, health: 900, canMove: true, iconType: "moduleshare" }],
    [77, { defID: 77, name: "terraunit", humanName: "Terraform", metalCost: 0, health: 10000, canMove: true, iconType: "" }],
  ]);
  snap.units.set(9, { unitID: 9, defID: 77, samples: [{ frame: 6, x: 100, z: 100, hp: 255, build: 255 }] });
  snap.events.push({ kind: "spawn", frame: 6, unitID: 9, int1: 77, int2: 0, int3: -1 });
  snap.events.push({ kind: "death", frame: 300, unitID: 9, int1: 1, int2: 0, int3: -1 });

  const zkr = buildZkrFromResim(snap, { projectiles: "heavy" });
  const artifact = await ZkrReplay.parse(new Uint8Array(Buffer.from(zkr)));
  assert.equal(artifact.pos.units.length, 3); // bytes still carry it (old artifacts)
  const model = ZkrReplay.artifactToModel(artifact);
  assert.ok(!model.units.some((u) => u.def === "terraunit"), "terraunit filtered from units");
  assert.ok(!model.units.some((u) => u.id === 9), "terraunit track absent (not just renamed)");
  assert.ok(model.units.some((u) => u.id === 1));
  assert.ok(!model.feedData.some((f) => f.txt.includes("Terraform")), "no terraunit death in the feed");
});

test("recycled projectile IDs pack as two independent short flights", async () => {
  const snap = syntheticSnapshot();
  snap.closedProjectiles = [{
    proID: 100, weaponDefID: 7, ownerTeam: 0,
    samples: [
      { frame: 6, x: 8192, z: 4096, y: 100 },
      { frame: 12, x: 8196, z: 4100, y: 150 },
      { frame: 18, x: 8200, z: 4104, y: 120 },
    ],
  }];
  // same ID, ~2.7 min later: a completely unrelated missile
  snap.projectiles.get(100)!.samples = [
    { frame: 5000, x: 4096, z: 8192, y: 100 },
    { frame: 5006, x: 4096, z: 8200, y: 150 },
  ];

  const zkr = buildZkrFromResim(snap, { projectiles: "heavy" });
  const artifact = await ZkrReplay.parse(new Uint8Array(Buffer.from(zkr)));
  assert.equal(artifact.proj.paths.length, 2);
  const spans = artifact.proj.paths.map((p) => p.samples.t[p.samples.n - 1] * 30 - p.startFrame);
  assert.ok(spans.every((s) => s <= 12.01), "each flight spans a handful of frames, not minutes: " + spans);
  const model = ZkrReplay.artifactToModel(artifact);
  assert.equal(model.projectiles.length, 2);
  assert.ok(model.projectiles[0].born !== model.projectiles[1].born);
  // no sample jump inside either path (the old contamination marker)
  for (const p of model.projectiles) {
    for (let i = 1; i < p.path.length; i++) {
      const dt = p.path[i].t - p.path[i - 1].t;
      assert.ok(dt <= 0.6, "path step " + dt + "s exceeds one probe gap");
    }
  }
});

test("legacy artifacts: one contaminated proID path splits into two flights at model build", async () => {
  const snap = syntheticSnapshot();
  // exactly what the pre-fix ingest baked: two unrelated flights of the
  // same recycled ID concatenated into a single track
  snap.projectiles.get(100)!.samples = [
    { frame: 6, x: 8192, z: 4096, y: 100 },
    { frame: 12, x: 8196, z: 4100, y: 150 },
    { frame: 5000, x: 4096, z: 8192, y: 100 },   // 166 s hole: ID reuse
    { frame: 5006, x: 4096, z: 8200, y: 150 },
  ];

  const zkr = buildZkrFromResim(snap, { projectiles: "heavy" });
  const artifact = await ZkrReplay.parse(new Uint8Array(Buffer.from(zkr)));
  assert.equal(artifact.proj.paths.length, 1); // bytes are what they are
  const model = ZkrReplay.artifactToModel(artifact);
  assert.equal(model.projectiles.length, 2, "split at the >1 s sample hole");
  const [first, second] = model.projectiles;
  assert.ok(Math.abs(first.end - 12 / 30) < 1e-3);
  assert.ok(Math.abs(second.born - 5000 / 30) < 1e-3);
  for (const p of model.projectiles) {
    for (let i = 1; i < p.path.n; i++) {
      assert.ok(p.path.t[i] - p.path.t[i - 1] <= 0.6, "no cross-map crawl steps");
    }
  }
});

test("morph deaths read as morphed: same-team spawn on the same spot, no wreck", async () => {
  const snap = syntheticSnapshot();
  // fixture death: unit 2 (team 1, def 11) dies at frame 900 with its only
  // sample at {6, (4096, 8192)}: give it a morph target — a same-team unit
  // spawning at frame 900 at that exact position
  snap.units.set(3, { unitID: 3, defID: 12, samples: [
    { frame: 900, x: 4096, z: 8192, hp: 255, build: 255 },
  ] });
  snap.events.push({ kind: "spawn", frame: 900, unitID: 3, int1: 12, int2: 1, int3: -1 });
  // ...and a genuine kill with no same-spot respawn: unit 4 (team 0) dies at 400
  snap.units.set(4, { unitID: 4, defID: 10, samples: [
    { frame: 6, x: 100, z: 100, hp: 255, build: 255 },
  ] });
  snap.events.push({ kind: "spawn", frame: 6, unitID: 4, int1: 10, int2: 0, int3: -1 });
  snap.events.push({ kind: "death", frame: 400, unitID: 4, int1: 1, int2: 0, int3: 42 });

  const zkr = buildZkrFromResim(snap, { projectiles: "heavy" });
  const artifact = await ZkrReplay.parse(new Uint8Array(Buffer.from(zkr)));
  const model = ZkrReplay.artifactToModel(artifact);
  const m2 = model.units.find((x) => x.id === 2)!;
  const m4 = model.units.find((x) => x.id === 4)!;
  assert.equal(m2.morph, true, "death+same-spot same-team spawn within 4 s = morph");
  assert.equal(m4.morph, false, "a kill with no respawn coincidence stays a death");
  const morphRow = model.feedData.find((f) => f.cls === "morph")!;
  assert.ok(morphRow, "feed has a morph row");
  assert.match(morphRow.txt, /morphed into/);
  assert.ok(model.feedData.some((f) => f.cls === "death" && f.txt.includes("destroyed")),
    "the genuine kill still reads destroyed");
  assert.ok(!model.feedData.some((f) => f.cls === "death" && f.txt.includes("Unit #2")),
    "the morph victim is not reported destroyed");
});

test("morph gates: kills never morph, fakeunit proxies excluded, post-gameover cleanup is no cancel", async () => {
  const snap = syntheticSnapshot();
  // unit 2's death keeps its ENEMY killer (unit 1) while a teammate
  // completes at the same spot in the same frame - a kill, never a morph
  snap.events[2] = { kind: "death", frame: 900, unitID: 2, int1: 1, int2: 0, int3: 42 };
  snap.units.set(3, { unitID: 3, defID: 12, samples: [
    { frame: 900, x: 4096, z: 8192, hp: 255, build: 255 },
  ] });
  snap.events.push({ kind: "spawn", frame: 900, unitID: 3, int1: 12, int2: 1, int3: -1 });
  // a killer-less complete death next to a fakeunit_los proxy spawn: the
  // proxy is not a valid morph target (Scan Sweep LoS provider)
  snap.unitDefs.set(13, { defID: 13, name: "fakeunit_los", metalCost: 5, health: 100, canMove: true, iconType: "none", humanName: "LOS Provider" });
  snap.units.set(8, { unitID: 8, defID: 11, samples: [
    { frame: 100, x: 6000, z: 6000, hp: 255, build: 255 },
  ] });
  snap.events.push({ kind: "spawn", frame: 100, unitID: 8, int1: 11, int2: 1, int3: -1 });
  snap.events.push({ kind: "death", frame: 300, unitID: 8, int1: -1, int2: 1, int3: -1 });
  snap.units.set(9, { unitID: 9, defID: 13, samples: [
    { frame: 300, x: 6000, z: 6000, hp: 255, build: 255 },
  ] });
  snap.events.push({ kind: "spawn", frame: 300, unitID: 9, int1: 13, int2: 1, int3: -1 });
  // a nanoframe dying killer-less AFTER the gameover frame (fixture gameover
  // at 1500): defeat cleanup reads destroyed, not cancelled
  snap.unitDefs.set(14, { defID: 14, name: "solarfake", metalCost: 70, health: 200, canMove: false, iconType: "energy_med", humanName: "Test Nanoframe" });
  snap.units.set(10, { unitID: 10, defID: 14, samples: [
    { frame: 1550, x: 2000, z: 4000, hp: 40, build: 60 },
  ] });
  snap.events.push({ kind: "spawn", frame: 1550, unitID: 10, int1: 14, int2: 0, int3: -1 });
  snap.events.push({ kind: "death", frame: 1600, unitID: 10, int1: -1, int2: 0, int3: -1 });

  const zkr = buildZkrFromResim(snap, { projectiles: "heavy" });
  const model = ZkrReplay.artifactToModel(await ZkrReplay.parse(new Uint8Array(Buffer.from(zkr))));
  assert.ok(!model.units.find((x) => x.id === 2)!.morph,
    "a killer-attributed death never pairs as a morph");
  assert.ok(!model.feedData.some((f) => f.cls === "morph"), "no morph row despite the same-spot spawn");
  assert.ok(model.feedData.some((f) => f.cls === "death" && f.txt.indexOf("Unit #2") !== -1),
    "the kill still reads destroyed");
  assert.ok(!model.units.some((x) => x.def === "fakeunit_los"),
    "fakeunit_los units never reach the model");
  assert.ok(!model.feedData.some((f) => f.txt.indexOf("LOS Provider") !== -1),
    "no fakeunit feed noise");
  assert.ok(!model.units.find((x) => x.id === 8)!.morph,
    "a fakeunit child is not a morph target");
  const cleanup = model.feedData.find((f) => f.txt.indexOf("Test Nanoframe") !== -1);
  assert.ok(cleanup, "post-gameover destroy has a feed line");
  assert.equal(cleanup!.cls, "death", "post-gameover cleanup reads destroyed, not cancelled");
  assert.match(cleanup!.txt, /destroyed/);
});

test("commander morph reads chassis + level, cancelled nanoframes read cancelled", async () => {
  const snap = syntheticSnapshot();
  // team-0 commander chain: chassis def (humanName "Guardian") dies at 900
  // exactly when dynassault1_00 spawns under it — ZK levels are shown as
  // comm_level+1, so the message says level 2, not "morphed into dynassault1"
  snap.unitDefs.set(50, { defID: 50, name: "dyntrainer_assault_base", metalCost: 1100, health: 4400, canMove: true, iconType: "commander1", humanName: "Guardian" });
  snap.unitDefs.set(51, { defID: 51, name: "dynassault1_00", metalCost: 1100, health: 5000, canMove: true, iconType: "commander2", humanName: "" });
  snap.units.set(5, { unitID: 5, defID: 50, samples: [
    { frame: 6, x: 500, z: 500, hp: 255, build: 255 },
  ] });
  snap.events.push({ kind: "spawn", frame: 6, unitID: 5, int1: 50, int2: 0, int3: -1 });
  snap.events.push({ kind: "death", frame: 900, unitID: 5, int1: -1, int2: 0, int3: -1 });
  snap.units.set(6, { unitID: 6, defID: 51, samples: [
    { frame: 900, x: 500, z: 500, hp: 255, build: 255 },
  ] });
  snap.events.push({ kind: "spawn", frame: 900, unitID: 6, int1: 51, int2: 0, int3: -1 });
  // cancelled nanoframe: dies at build 12% with no killer — the builder
  // cancelled the frame; the old read of this death was a false morph
  snap.unitDefs.set(52, { defID: 52, name: "weaver", metalCost: 200, health: 250, canMove: true, iconType: "spidersupport", humanName: "Weaver" });
  snap.units.set(7, { unitID: 7, defID: 52, samples: [
    { frame: 300, x: 1000, z: 1000, hp: 30, build: 30 },
  ] });
  snap.events.push({ kind: "spawn", frame: 300, unitID: 7, int1: 52, int2: 1, int3: -1 });
  snap.events.push({ kind: "death", frame: 400, unitID: 7, int1: -1, int2: 1, int3: -1 });

  const zkr = buildZkrFromResim(snap, { projectiles: "heavy" });
  const artifact = await ZkrReplay.parse(new Uint8Array(Buffer.from(zkr)));
  const model = ZkrReplay.artifactToModel(artifact);
  const commMorph = model.feedData.find((f) => f.cls === "morph" && f.txt.includes("Guardian"));
  assert.ok(commMorph, "feed carries the commander morph");
  assert.match(commMorph!.txt, /Guardian morphed to level 2/,
    "level = target def digit + 1 (ZK shows comm_level+1)");
  const cancelled = model.feedData.find((f) => f.cls === "cancelled");
  assert.ok(cancelled, "cancelled nanoframe death gets its own feed class");
  assert.match(cancelled!.txt, /Weaver was cancelled/);
  // a cancelled nanoframe with a same-spot replacement never reads as a morph
  assert.ok(!model.units.some((u) => u.id === 7 && u.morph), "nanoframe victim is not a morph");
  // commander level + effective value: base = level 0 at the recorded cost,
  // dynassault1_00 = level 1 at base + the 50-metal first morph cost
  const m5 = model.units.find((x) => x.id === 5)!;
  const m6 = model.units.find((x) => x.id === 6)!;
  assert.equal(m5.commLevel, 0, "base chassis def is comm level 0");
  assert.equal(m5.metalValue, 1100, "base comm value is the recorded cost");
  assert.equal(m6.commLevel, 1, "dynassault1_00 embeds comm level 1");
  assert.equal(m6.metalValue, 1150, "level-1 value = 1100 base + first morph cost");
});


test("states, antinuke coverage, missile explosions, napalm and superweapon news decode", async () => {
  const snap = syntheticSnapshot();
  // anti-nuke launcher with ZK's real coverage (staticantinuke 2500 elmos)
  snap.unitDefs.set(20, { defID: 20, name: "staticantinuke", metalCost: 900, health: 2000, canMove: false, iconType: "antinuke", humanName: "Antinuke", antiNukeCoverage: 2500 });
  snap.units.set(11, { unitID: 11, defID: 20, samples: [
    { frame: 6, x: 3000, z: 3000, hp: 255, build: 255 },
  ] });
  snap.events.push({ kind: "spawn", frame: 6, unitID: 11, int1: 20, int2: 0, int3: -1 });
  // a Firewalker shell: ZK-classified napalm weapon -> ground napalm at
  // impact (after the classifier fix the recorded flag — not bare area
  // damage — gates the class, matching the widget's nd column)
  snap.weaponDefs.set(30, { defID: 30, name: "Napalm Mortar", type: "Cannon", range: 620, aoe: 80, areaDamageRadius: 64, areaDamageDuration: 16, napalm: true });
  snap.projectiles.set(101, { proID: 101, weaponDefID: 30, projClass: 2, ownerTeam: 0, startFrame: 50,
    samples: [{ frame: 50, x: 4000, z: 4000, y: 100 }, { frame: 56, x: 4400, z: 4400, y: 60 }] });
  // a Zeno slow missile: area damage but NOT fire (nd 0, no area fields
  // recorded - artifacts from the pre-slow-field widget) -> the impact
  // leaves a lingering purple slow-zone patch with the fixed game values
  snap.weaponDefs.set(38, { defID: 38, name: "missileslow_weapon", type: "StarburstLauncher", range: 6000, aoe: 320, areaDamageRadius: 0, areaDamageDuration: 0, napalm: false });
  snap.projectiles.set(110, { proID: 110, weaponDefID: 38, projClass: 4, ownerTeam: 0, startFrame: 70,
    samples: [{ frame: 70, x: 5000, z: 5000, y: 200 }, { frame: 76, x: 5500, z: 5500, y: 0 }] });
  // Placeholder's black hole (jumpblackhole - the Black-Hole artillery
  // unit): no recorded area fields either -> dark grey lingering circle
  // at the fixed game values 70 / 13.3 s
  snap.weaponDefs.set(39, { defID: 39, name: "jumpblackhole_black_hole", type: "Cannon", range: 900, trajectoryHeight: 300, aoe: 300, areaDamageRadius: 0, areaDamageDuration: 0, napalm: false });
  snap.projectiles.set(111, { proID: 111, weaponDefID: 39, projClass: 1, ownerTeam: 0, startFrame: 90,
    samples: [{ frame: 90, x: 6000, z: 6000, y: 100 }, { frame: 95, x: 6100, z: 6100, y: 0 }] });
  // impact-AoE rings for the non-strategic big guns: Bertha plasma, the
  // disco's red/orange cannons, one Dante rocket salvo volley (aoe values
  // in the RECORDED convention - Spring's damageAreaOfEffect radius, half
  // the lua areaOfEffect diameter, as real WDEFs carry them)
  snap.weaponDefs.set(40, { defID: 40, name: "staticheavyarty_plasma", type: "Cannon", range: 12000, trajectoryHeight: 300, aoe: 88, areaDamageRadius: 0, areaDamageDuration: 0, napalm: false });
  snap.projectiles.set(112, { proID: 112, weaponDefID: 40, projClass: 1, ownerTeam: 0, startFrame: 120,
    samples: [{ frame: 120, x: 2000, z: 2000, y: 400 }, { frame: 130, x: 3000, z: 3000, y: 0 }] });
  snap.weaponDefs.set(41, { defID: 41, name: "raveparty_red_killer", type: "Cannon", range: 4000, trajectoryHeight: 200, aoe: 96, areaDamageRadius: 0, areaDamageDuration: 0, napalm: false });
  snap.projectiles.set(113, { proID: 113, weaponDefID: 41, projClass: 1, ownerTeam: 0, startFrame: 135,
    samples: [{ frame: 135, x: 4000, z: 2000, y: 100 }, { frame: 140, x: 4100, z: 2100, y: 0 }] });
  snap.weaponDefs.set(42, { defID: 42, name: "raveparty_orange_roaster", type: "Cannon", range: 4000, trajectoryHeight: 200, aoe: 400, areaDamageRadius: 0, areaDamageDuration: 0, napalm: false });
  snap.projectiles.set(114, { proID: 114, weaponDefID: 42, projClass: 1, ownerTeam: 0, startFrame: 145,
    samples: [{ frame: 145, x: 5000, z: 2000, y: 100 }, { frame: 150, x: 5100, z: 2100, y: 0 }] });
  snap.weaponDefs.set(43, { defID: 43, name: "striderdante_napalm_rockets_salvo", type: "MissileLauncher", range: 800, aoe: 84, areaDamageRadius: 78, areaDamageDuration: 3, napalm: true });
  snap.projectiles.set(115, { proID: 115, weaponDefID: 43, projClass: 4, ownerTeam: 0, startFrame: 155,
    samples: [{ frame: 155, x: 6000, z: 2000, y: 80 }, { frame: 160, x: 6100, z: 2100, y: 0 }] });
  // the Pyro's death flame ball: jumpraid dies -> lingering orange patch at
  // the wreck (explode weapons have no flight, the death spot is the anchor)
  snap.unitDefs.set(400, { defID: 400, name: "jumpraid", metalCost: 260, health: 240, canMove: true, iconType: "pyro", humanName: "Pyro" });
  snap.units.set(400, { unitID: 400, defID: 400, samples: [
    { frame: 400, x: 7000, z: 7000, hp: 255, build: 255 },
    { frame: 449, x: 7000, z: 7000, hp: 255, build: 255 },
  ] });
  snap.events.push({ kind: "spawn", frame: 400, unitID: 400, int1: 400, int2: 0, int3: -1 });
  snap.events.push({ kind: "death", frame: 450, unitID: 400, int1: -1, int2: 0, int3: -1 });
  // an Eos tactical nuke: the missile UNIT stockpiles/stages at the map
  // corner until liftoff, so its death must NOT anchor the blast — the
  // warhead FLIGHT (wdef tacnuke_weapon) is the detonation, at its last
  // sample. Unit 12 below is the regression probe: it dies at the corner.
  snap.unitDefs.set(21, { defID: 21, name: "tacnuke", metalCost: 0, health: 100, canMove: true, iconType: "cruisemissilesmall", humanName: "Eos" });
  snap.units.set(12, { unitID: 12, defID: 21, samples: [
    { frame: 100, x: 16384, z: 16384, hp: 255, build: 255 },
    { frame: 294, x: 16384, z: 16384, hp: 255, build: 255 },
  ] });
  snap.events.push({ kind: "spawn", frame: 100, unitID: 12, int1: 21, int2: 1, int3: -1 });
  snap.events.push({ kind: "death", frame: 300, unitID: 12, int1: -1, int2: 1, int3: -1 });
  // unit 14 is also an Eos but NEVER stages: it stays in its silo until an
  // enemy kills it - a launch it is not, and the feed must say so
  snap.units.set(14, { unitID: 14, defID: 21, samples: [
    { frame: 100, x: 3000, z: 3000, hp: 255, build: 255 },
    { frame: 294, x: 3000, z: 3000, hp: 255, build: 255 },
  ] });
  snap.events.push({ kind: "spawn", frame: 100, unitID: 14, int1: 21, int2: 1, int3: -1 });
  snap.events.push({ kind: "death", frame: 320, unitID: 14, int1: 33, int2: 1, int3: -1 });
  snap.weaponDefs.set(31, { defID: 31, name: "tacnuke_weapon", type: "MissileLauncher", range: 900, aoe: 192 });
  snap.projectiles.set(102, { proID: 102, weaponDefID: 31, projClass: 4, ownerTeam: 1, startFrame: 294,
    samples: [{ frame: 294, x: 8192, z: 8192, y: 200 }, { frame: 300, x: 9000, z: 9100, y: 0 }] });
  // prefixed warhead names from the real The Hole artifact: empmissile_emp_weapon
  // (Shockley) and staticnuke_crblmssl (Trinity) must match despite the unit-key
  // prefix / double suffix; the antinuke's interceptor rocket must NOT paint
  snap.weaponDefs.set(32, { defID: 32, name: "empmissile_emp_weapon", type: "MissileLauncher", range: 900, aoe: 140 });
  snap.projectiles.set(103, { proID: 103, weaponDefID: 32, projClass: 4, ownerTeam: 1, startFrame: 354,
    samples: [{ frame: 354, x: 1000, z: 1000, y: 200 }, { frame: 360, x: 2000, z: 2000, y: 0 }] });
  // a second Shockley flight 2 frames after the first: same volley, and the
  // launch news must aggregate the pair into ONE line
  snap.projectiles.set(109, { proID: 109, weaponDefID: 32, projClass: 4, ownerTeam: 1, startFrame: 356,
    samples: [{ frame: 356, x: 1100, z: 1100, y: 200 }, { frame: 362, x: 2100, z: 2100, y: 0 }] });
  snap.weaponDefs.set(33, { defID: 33, name: "staticnuke_crblmssl", type: "StarburstLauncher", range: 72000, aoe: 960 });
  snap.projectiles.set(104, { proID: 104, weaponDefID: 33, projClass: 3, ownerTeam: 0, startFrame: 414,
    samples: [{ frame: 414, x: 3000, z: 3000, y: 200 }, { frame: 420, x: 4000, z: 4000, y: 0 }] });
  snap.weaponDefs.set(34, { defID: 34, name: "staticantinuke_amd_rocket", type: "StarburstLauncher", range: 3800, aoe: 210 });
  snap.projectiles.set(105, { proID: 105, weaponDefID: 34, projClass: 3, ownerTeam: 1, startFrame: 474,
    samples: [{ frame: 474, x: 5000, z: 5000, y: 200 }, { frame: 480, x: 6000, z: 6000, y: 0 }] });
  // the Scylla's tactical-nuke torpedo: its wdef name CONTAINS "tacnuke"
  // (subtacmissile_tacnuke) - the unit-key match must NOT classify it as
  // an Eos strike (counter-review H1)
  snap.weaponDefs.set(35, { defID: 35, name: "subtacmissile_tacnuke", type: "Cannon", range: 1200, trajectoryHeight: 50, aoe: 256 });
  snap.projectiles.set(106, { proID: 106, weaponDefID: 35, projClass: 2, ownerTeam: 0, startFrame: 534,
    samples: [{ frame: 534, x: 2000, z: 2000, y: 100 }, { frame: 540, x: 2500, z: 2500, y: 0 }] });
  // a Trinity the antinuke killed MID-AIR: the warhead's flight end and an
  // antinuke rocket's end coincide in time and space - no ground
  // detonation, no strike circle (counter-review M2)
  snap.weaponDefs.set(36, { defID: 36, name: "staticnuke_crblmssl", type: "StarburstLauncher", range: 72000, aoe: 960 });
  snap.projectiles.set(107, { proID: 107, weaponDefID: 36, projClass: 3, ownerTeam: 0, startFrame: 594,
    samples: [{ frame: 594, x: 7000, z: 7000, y: 500 }, { frame: 600, x: 7500, z: 7500, y: 350 }] });
  snap.weaponDefs.set(37, { defID: 37, name: "staticantinuke_amd_rocket", type: "StarburstLauncher", range: 3800, aoe: 210 });
  snap.projectiles.set(108, { proID: 108, weaponDefID: 37, projClass: 3, ownerTeam: 1, startFrame: 595,
    samples: [{ frame: 595, x: 5000, z: 5000, y: 600 }, { frame: 600, x: 7500, z: 7450, y: 340 }] });
  // a WIDE genuine kill: a fast Trinity and its interceptor end in the same
  // probe frame, but one probe interval of closing speed leaves their last
  // samples 500 elmos apart (measured on the stress replay: 326) - past the
  // old fixed 300 gate, which painted a fake ground detonation at the
  // intercept. The cadence-scaled radius must still pair them.
  snap.weaponDefs.set(50, { defID: 50, name: "staticnuke_crblmssl", type: "StarburstLauncher", range: 72000, aoe: 960 });
  snap.projectiles.set(116, { proID: 116, weaponDefID: 50, projClass: 3, ownerTeam: 0, startFrame: 690,
    samples: [{ frame: 690, x: 6000, z: 6000, y: 400 }, { frame: 696, x: 6300, z: 6300, y: 300 }] });
  snap.weaponDefs.set(51, { defID: 51, name: "staticantinuke_amd_rocket", type: "StarburstLauncher", range: 3800, aoe: 210 });
  snap.projectiles.set(117, { proID: 117, weaponDefID: 51, projClass: 3, ownerTeam: 1, startFrame: 691,
    samples: [{ frame: 691, x: 6900, z: 6900, y: 400 }, { frame: 696, x: 6700, z: 6600, y: 300 }] });
  // PTGT: commanded warhead destinations. The clean Trinity gets one row
  // (its circle anchors at the target, not the last sample); the
  // INTERCEPTED Trinity gets a stale early row plus the real one - the
  // LATEST row at-or-before the flight's end wins, so proID recycling
  // never crosses targets across flights
  snap.ptgts = [
    { proID: 104, frame: 414, x: 6000, z: 6000 },
    { proID: 107, frame: 500, x: 1500, z: 1500 },
    { proID: 107, frame: 595, x: 9000, z: 9400 },
  ];
  // superweapon news: a Zenith nanoframe appearing
  snap.unitDefs.set(22, { defID: 22, name: "zenith", metalCost: 15000, health: 9000, canMove: false, iconType: "zenith", humanName: "Zenith" });
  snap.events.push({ kind: "spawn", frame: 600, unitID: 13, int1: 22, int2: 0, int3: -1 });
  // live states: unit 1 fully EMP-stunned and slowed to 3/16 at frame 120
  snap.states = [{ unitID: 1, frame: 120, bits: 4, slow: 3 / 16 }];
  // staging-corpse gate (feature mode): raw position bands alone must NEVER
  // drop a wreck - Otago's real corner casualties (a Jumpjet Factory among
  // them) proved that. A corner feature is staging carrion only when a
  // LAUNCHED missile died within +/-36 frames of it (unit 12: staged,
  // died f=300); one born far from any missile death is a real corner
  // casualty and must survive.
  snap.events.push({ kind: "wreck", frame: 300, unitID: 900, int1: 40, int2: 16000, int3: 8 });
  snap.events.push({ kind: "wreck", frame: 2100, unitID: 901, int1: 40, int2: 16000, int3: 8 });
  // census-driven death blasts: a Skuttle (90 - the effective damage
  // radius, half the lua aoe 180, per gui_blastRadius) and a Detriment
  // (640 NUCLEAR_MISSILE, effective radius - nuke grade, vector art)
  snap.unitDefs.set(23, { defID: 23, name: "jumpbomb", metalCost: 100, health: 800, canMove: true, iconType: "jumpbomb", humanName: "Skuttle" });
  snap.units.set(15, { unitID: 15, defID: 23, samples: [
    { frame: 320, x: 4000, z: 4000, hp: 255, build: 255 },
    { frame: 354, x: 4000, z: 4000, hp: 255, build: 255 },
  ] });
  snap.events.push({ kind: "spawn", frame: 320, unitID: 15, int1: 23, int2: 0, int3: -1 });
  snap.events.push({ kind: "death", frame: 354, unitID: 15, int1: -1, int2: 0, int3: -1 });
  snap.unitDefs.set(24, { defID: 24, name: "striderdetriment", metalCost: 4000, health: 20000, canMove: false, iconType: "striderdetriment", humanName: "Detriment" });
  snap.units.set(16, { unitID: 16, defID: 24, samples: [
    { frame: 320, x: 8000, z: 2000, hp: 255, build: 255 },
    { frame: 366, x: 8000, z: 2000, hp: 255, build: 255 },
  ] });
  snap.events.push({ kind: "spawn", frame: 320, unitID: 16, int1: 24, int2: 1, int3: -1 });
  snap.events.push({ kind: "death", frame: 366, unitID: 16, int1: -1, int2: 1, int3: -1 });

  const zkr = buildZkrFromResim(snap, { projectiles: "heavy" });
  const model = ZkrReplay.artifactToModel(await ZkrReplay.parse(new Uint8Array(Buffer.from(zkr))));

  // states travel through pack -> parse with the slow fraction intact
  const st = model.units.find((u) => u.id === 1)!.states;
  assert.equal(st.n, 1, "state transition recorded");
  assert.equal(st.b[0], 4, "EMP bit");
  assert.ok(Math.abs(st.sl[0] - 3 / 16) < 1e-9, "slow fraction survives the u8 quantization");
  assert.equal(st.t[0], 4, "state time in play-seconds");

  // anti-nuke coverage straight from the def
  assert.equal(model.units.find((u) => u.id === 11)!.antiNuke, 2500);

  // Eos detonation anchored at the warhead FLIGHT's last sample (impact),
  // radius from WDEF aoe; the missile unit's corner death must NOT paint one
  assert.equal(model.explosions.length, 10,
    "Eos + both Shockleys + the clean Trinity + the Skuttle and Detriment death blasts + the four impact rings (Bertha, DRP red/orange, Dante salvo); no corner blast from the unit deaths, none from the antinuke interceptor");
  const eos = model.explosions.find((e) => e.r === 192);
  assert.ok(eos, "Eos explosion present");
  assert.equal(eos!.fade, "fast");
  assert.ok(Math.abs(eos!.t - 10) < 0.01, "detonation at the warhead impact (frame 300/30)");
  assert.ok(Math.abs(eos!.x - 9000 / 16384) < 0.01 && Math.abs(eos!.y - 9100 / 16384) < 0.01,
    "explosion at the flight's impact sample, not the missile unit's staging corner (16384/16384)");
  // prefixed real-world weapon names must still anchor their blast
  assert.equal(model.explosions.filter((e) => e.col === "72,214,255").length, 2,
    "both Shockley explosions from the unit-key-prefixed empmissile_emp_weapon at their impacts");
  const trinity = model.explosions.find((e) => e.r === 960);
  assert.ok(trinity && Math.abs(trinity!.t - 14) < 0.01,
    "Trinity explosion from staticnuke_crblmssl at its impact");
  assert.equal(trinity!.fx, true, "the Trinity detonation carries the vector-blast flag");
  assert.equal(model.explosions.find((e) => e.r === 192)!.fx, false,
    "tactical/EMP/seismic blasts keep the default AOE circles");
  // in-flight markers: only the Trinity warhead and the antinuke interceptor
  // carry one (drawn as a slight team-coloured border at the flight head);
  // the warhead uses the missile's own nuke_missile icon, not the structure's
  assert.equal(model.projectiles.find((p) => p.icon === "nuke_missile")!.weaponDefID, 33,
    "staticnuke_crblmssl flight gets the nuke_missile.png marker");
  assert.equal(model.projectiles.find((p) => p.icon === "antinuke_proj")!.weaponDefID, 34,
    "the antinuke interceptor flight gets the antinuke_proj.png marker");
  assert.ok(model.projectiles.filter((p) => p.icon).length === 6,
    "Eos/Shockley flights stay plain trails; both interceptor pairs and all three Trinities carry markers");
  // incoming-strike visualisation: the five silo missiles (+ Trinity) carry
  // their own colour and AOE for the target circle; the interceptor flies
  // colourless (defensive, no target to mark)
  const missAF = model.projectiles.filter((p) => p.mcol);
  assert.ok(missAF.length === 7, "Eos + both Shockleys + all three Trinities + the Zeno carry strike colours");
  assert.equal(missAF.find((p) => p.weaponDefID === 31)!.mcol, "255,72,56", "Eos red");
  assert.equal(missAF.find((p) => p.weaponDefID === 31)!.maoe, 192, "Eos AOE from WDEF");
  assert.equal(missAF.find((p) => p.weaponDefID === 32)!.mcol, "72,214,255", "Shockley blue");
  assert.equal(missAF.find((p) => p.weaponDefID === 38)!.mcol, "168,96,255", "Zeno purple");
  assert.equal(missAF.find((p) => p.weaponDefID === 33)!.mcol, "255,72,56", "Trinity red");
  assert.ok(model.projectiles.find((p) => p.weaponDefID === 34)!.mcol === undefined,
    "the antinuke interceptor carries no strike colour");
  // the Scylla torpedo (subtacmissile_tacnuke) must NOT read as a strike
  const scylla = model.projectiles.find((p) => p.weaponDefID === 35)!;
  assert.ok(scylla.mcol === undefined && scylla.icon === undefined,
    "the unit-key match ignores the tacnuke inside subtacmissile_tacnuke");
  assert.ok(!model.explosions.some((e) => e.r === 256),
    "no Eos-style detonation painted at the torpedo impact");
  // the intercepted Trinity: coloured for its flight, but its end
  // coincides with the antinuke rocket's -> no ground detonation, no target
  const intercepted = model.projectiles.find((p) => p.weaponDefID === 36)!;
  assert.equal(intercepted.mcol, "255,72,56", "the intercepted warhead still flies red");
  assert.equal(intercepted.intercepted, true, "its flight end matches the antinuke rocket's");
  assert.ok(model.explosions.filter((e) => e.r === 960 && Math.abs(e.t - 20) < 0.01).length === 0,
    "no ground detonation for the mid-air kill");
  const clean = model.projectiles.find((p) => p.weaponDefID === 33)!;
  assert.ok(clean.intercepted === undefined,
    "a warhead whose end matches no rocket detonates normally");
  // the earlier interceptor flight (105) ends far from any warhead end -
  // it must not mark anything
  assert.ok(model.projectiles.filter((p) => p.intercepted).length === 2,
    "exactly the two paired warheads read as intercepted");
  // the WIDE kill (proID 116 vs 117): 500 elmos apart at the same frame -
  // one probe interval of closing speed, the stress-replay geometry that
  // used to slip past a fixed 300 and paint a fake ground detonation
  const wide = model.projectiles.find((p) => p.weaponDefID === 50)!;
  assert.equal(wide.intercepted, true,
    "a same-frame kill with last samples 500 elmos apart still pairs as an intercept");
  assert.ok(model.explosions.filter((e) => e.r === 960 && Math.abs(e.t - 696 / 30) < 0.01).length === 0,
    "no ground detonation for the wide kill");
  assert.ok(model.feedData.some((f) => f.cls === "intercept" &&
    Math.abs(f.tm - 696 / 30) < 1e-3),
    "the wide kill gets its intercept feed line");

  // ---- recorded warhead targets (PTGT) ----
  // the clean Trinity's flight carries the commanded destination as map
  // fractions; flights without a row keep tgt undefined (page keeps using
  // the flight's own end = real impact)
  const trClean = model.projectiles.find((p) => p.weaponDefID === 33)!;
  assert.ok(trClean.tgt && Math.abs(trClean.tgt.x - 6000 / 16384) < 2e-4 &&
    Math.abs(trClean.tgt.z - 6000 / 16384) < 2e-4,
    "recorded target attaches to the flight (u16 elmo quantization within tolerance)");
  assert.ok(model.projectiles.find((p) => p.weaponDefID === 31)!.tgt === undefined,
    "a flight with no PTGT row gets no invented target");
  // the INTERCEPTED Trinity still tells its real destination: the LATEST
  // row at-or-before its end wins, the stale parking-era row is ignored
  const trIcept = model.projectiles.find((p) => p.weaponDefID === 36)!;
  assert.ok(trIcept.tgt && Math.abs(trIcept.tgt.x - 9000 / 16384) < 2e-4 &&
    Math.abs(trIcept.tgt.z - 9400 / 16384) < 2e-4,
    "the intercepted warhead's target is the latest row at-or-before its end");
  // it stays intercepted (no ground detonation) AND now has a destination
  // to circle instead of nothing
  assert.equal(trIcept.intercepted, true);

  // ground napalm from the shell's impact, game radius/duration
  const np = model.napalm.find((n) => n.r === 64);
  assert.ok(np, "napalm patch present");
  assert.equal(np!.dur, 16);
  assert.ok(Math.abs(np!.t - 56 / 30) < 0.05,
    "napalm starts at the impact (frames 50/56 -> last sample)");

  // Zeno's slow zone: purple patch at the impact, fixed 320/30 game
  // values (the fixture records no area fields, like real artifacts
  // from the widget before slow-field adr/adu recording)
  const zeno = model.napalm.find((n) => n.col === "168,96,255");
  assert.ok(zeno, "slow-field patch present");
  assert.equal(zeno!.r, 320);
  assert.equal(zeno!.dur, 30);
  // Placeholder's black hole: dark grey 70/13.3
  const bh = model.napalm.find((n) => n.col === "90,90,90");
  assert.ok(bh, "black-hole patch present");
  assert.equal(bh!.r, 70);
  assert.ok(Math.abs(bh!.dur - 13.3) < 1e-9);
  // impact-AoE rings: Bertha plasma (colour from its plasma), the disco's
  // red/orange cannons (colour matches the NAME), Dante's salvo
  assert.ok(model.explosions.some((e) => e.r === 88 && e.col === "150,190,255"),
    "Bertha plasma impact ring");
  assert.ok(model.explosions.some((e) => e.r === 96 && e.dur === 2 && e.col === "255,72,56"),
    "DRP Red Killer impact ring, red like its name");
  assert.ok(model.explosions.some((e) => e.r === 400 && e.col === "255,138,40" && e.dur === 2),
    "DRP Orange Roaster impact ring, orange like its name");
  assert.ok(model.explosions.some((e) => e.r === 84 && e.col === "255,138,40" && e.dur === 3),
    "Dante rocket salvo impact ring");
  // DRP party zone: the disco's only lingering ground effect
  const oz = model.napalm.find((n) => n.col === "255,138,40" && n.r === 400);
  assert.ok(oz && oz.dur === 8, "DRP party-zone patch 400/8");
  // Dante rockets keep their burning-ground patch alongside the ring
  assert.ok(model.napalm.some((n) => n.r === 78 && n.dur === 3),
    "Dante salvo fire patch 78/3");
  // the Pyro's death flame ball at the death spot
  const pyroBall = model.napalm.find((n) => n.r === 128 && Math.abs(n.dur - 13.3) < 1e-9);
  assert.ok(pyroBall && !pyroBall.col, "Pyro death flame ball 128/13.3, default fire colour");
  assert.ok(Math.abs(pyroBall!.t - 450 / 30) < 0.05,
    "the flame ball starts at the Pyro's death");
  assert.equal(model.napalm.filter((n) => !n.col).length, 3,
    "colourless patches are exactly the three fire-family ones (firewalker shell, Dante salvo, Pyro ball)");

  // superweapon construction news in the feed
  assert.ok(model.feedData.some((f) => f.cls === "news" && /Zenith has begun construction!/.test(f.txt)),
    "superweapon news line");

  // ---- launch news: every warhead flight announces the launch ----
  assert.ok(model.feedData.some((f) => f.cls === "launch" && f.txt === "Eos launched!"),
    "a single Eos flight leaves one plain launch line");
  assert.ok(model.feedData.some((f) => f.cls === "launch" && f.txt === "2 \u00d7 Shockley missiles launched!"),
    "two Shockley flights 0.07 s apart aggregate into one volley line");
  assert.equal(model.feedData.filter((f) => f.cls === "launch" && /Trinity/.test(f.txt)).length, 3,
    "all three Trinity flights get news; their gaps never aggregate them");

  // ---- launched vs killed-in-silo missile units ----
  const u12 = model.units.find((u) => u.id === 12)!;
  assert.equal(u12.launched, true, "the staged Eos counts as launched");
  assert.ok(Math.abs(u12.launchTm - 100 / 30) < 1e-6,
    "launch time = the first staging-corner sample");
  assert.ok(!model.feedData.some((f) => f.txt === "Eos destroyed"),
    "a launched missile's later engine-side destroy leaves no destroyed line");
  const u14 = model.units.find((u) => u.id === 14)!;
  assert.equal(u14.launched, false, "an Eos that never staged was killed in its silo");
  assert.ok(model.feedData.some((f) => f.cls === "death" &&
    /^Eos was destroyed before launching/.test(f.txt)),
    "a missile killed in its silo gets its own wording, not a plain destroy");
  // staging-corpse gate (feature mode): raw position bands alone must NEVER
  // drop a wreck — Otago's real corner casualties (a Jumpjet Factory among
  // them) proved that. A corner feature is staging carrion only when a
  // LAUNCHED missile died within ±36 frames of it; one born far from any
  // missile death is a real corner casualty and must survive.
  // (fixture rows added before buildZkrFromResim above)
  assert.equal(model.wrecks.length, 1,
    "feature mode drops ONLY the corner corpse matching the missile sweep (unit 12 died f=300)");
  assert.ok(Math.abs(model.wrecks[0]!.x - 16000 / 16384) < 1e-4 && model.wrecks[0]!.metal === 40,
    "the late corner casualty — a REAL wreck — survives the gate");

  // census-driven death blasts: the Skuttle-class 90 circle (effective
  // radius = half the lua areaOfEffect diameter, matching ZK's own
  // blast-radius widget), the Detriment's 640 NUCLEAR_MISSILE blast
  // with the vector nuke art
  const skutBlast = model.explosions.find((e) => e.r === 90);
  assert.ok(skutBlast && Math.abs(skutBlast.t - 354 / 30) < 1e-6 &&
    Math.abs(skutBlast.x - 4000 / 16384) < 1e-4 && skutBlast.fx === false,
    "Skuttle death blast: circle at its death position/time, no blast art");
  const detBlast = model.explosions.find((e) => e.r === 640);
  assert.ok(detBlast && detBlast.fx === true && detBlast.col === "255,72,56" &&
    Math.abs(detBlast.t - 366 / 30) < 1e-6,
    "Detriment death blast: nuke-grade, red, uses the vector blast art");

  // ---- interception news (#33): the feed tells the whole nuke story ----
  assert.ok(model.feedData.some((f) => f.cls === "intercept" &&
    f.txt === "Trinity nuke intercepted by antinuke!" &&
    Math.abs(f.tm - 600 / 30) < 1e-3),
    "the mid-air intercept (proID 107 vs the antinuke rocket) gets its feed line");
});

test("wreck movement rows: falling aircraft wrecks leave a position trail", async () => {
  const snap = syntheticSnapshot();
  // an aircraft dies in the air: the feature is announced at the death
  // spot, then MOVES (falls/tumbles) for two more poll rows before rest
  snap.events.push(
    { kind: "wreck", frame: 900, unitID: 90001, int1: 88, int2: 3072, int3: 6144 },
    { kind: "wreck", frame: 930, unitID: 90001, int1: 88, int2: 4000, int3: 7000 },
    { kind: "wreck", frame: 960, unitID: 90001, int1: 88, int2: 4200, int3: 7200 },
    { kind: "unwreck", frame: 1500, unitID: 90001, int1: -1, int2: -1, int3: -1 },
  );
  const zkr = buildZkrFromResim(snap, { projectiles: "heavy" });
  const artifact = await ZkrReplay.parse(new Uint8Array(Buffer.from(zkr)));
  const model = ZkrReplay.artifactToModel(artifact);
  assert.equal(model.wrecks.length, 1, "the feature stays ONE wreck, not three");
  const w = model.wrecks[0]!;
  assert.ok(Math.abs(w.born - 30) < 1e-6, "born stays at the FIRST row");
  assert.ok(Math.abs(w.x - 4200 / 16384) < 1e-4 && Math.abs(w.y - 7200 / 16384) < 1e-4,
    "x/y track the resting spot (zone clustering sees where it settled)");
  assert.equal(w.pts.length, 3, "all three rows land in the trail");
  assert.ok(w.posAt, "a moving wreck gets a time lookup");
  const early = w.posAt(30.5);
  assert.ok(Math.abs(early.x - 3072 / 16384) < 1e-4, "before the first move row: death spot");
  const mid = w.posAt(31.5);
  assert.ok(Math.abs(mid.x - 4000 / 16384) < 1e-4, "mid-fall: the second row");
  const late = w.posAt(100);
  assert.ok(Math.abs(late.x - 4200 / 16384) < 1e-4, "at rest: the final row");
  assert.ok(Math.abs(w.gone - 50) < 1e-6, "the reclaim still ends the wreck");
});

test("staging corpse: a later movement row must not resurrect it", async () => {
  const snap = syntheticSnapshot();
  // a staged Eos dies at the corner (same shape as the big fixture): its
  // corner corpse is filtered as staging carrion, and a LATER movement row
  // landing inside the map must not bring it back
  snap.unitDefs.set(21, { defID: 21, name: "tacnuke", metalCost: 0, health: 100, canMove: true, iconType: "cruisemissilesmall", humanName: "Eos" });
  snap.units.set(12, { unitID: 12, defID: 21, samples: [
    { frame: 100, x: 16384, z: 16384, hp: 255, build: 255 },
    { frame: 294, x: 16384, z: 16384, hp: 255, build: 255 },
  ] });
  snap.events.push(
    { kind: "spawn", frame: 100, unitID: 12, int1: 21, int2: 1, int3: -1 },
    { kind: "death", frame: 300, unitID: 12, int1: -1, int2: 1, int3: -1 },
    { kind: "wreck", frame: 300, unitID: 95001, int1: 40, int2: 16384, int3: 16384 },
    { kind: "wreck", frame: 330, unitID: 95001, int1: 40, int2: 8000, int3: 8000 },
  );
  const zkr = buildZkrFromResim(snap, { projectiles: "heavy" });
  const artifact = await ZkrReplay.parse(new Uint8Array(Buffer.from(zkr)));
  const model = ZkrReplay.artifactToModel(artifact);
  assert.equal(model.wrecks.length, 0,
    "the skipped staging feature stays dead through its movement rows");
});

test("carrier drones stay on the map but leave the feed (#36)", async () => {
  const snap = syntheticSnapshot();
  snap.unitDefs.set(50, { defID: 50, name: "dronelight", metalCost: 45, health: 60, canMove: true, iconType: "gunshipraider", humanName: "Firefly" });
  snap.units.set(50, { unitID: 50, defID: 50, samples: [
    { frame: 6, x: 2000, z: 2000, hp: 255, build: 255 },
    { frame: 300, x: 2100, z: 2100, hp: 0, build: 255 },
  ] });
  snap.events.push(
    { kind: "spawn", frame: 6, unitID: 50, int1: 50, int2: 0, int3: -1 },
    { kind: "death", frame: 306, unitID: 50, int1: 1, int2: 0, int3: -1 },
  );
  const zkr = buildZkrFromResim(snap, { projectiles: "heavy" });
  const artifact = await ZkrReplay.parse(new Uint8Array(Buffer.from(zkr)));
  const model = ZkrReplay.artifactToModel(artifact);
  const u = model.units.find((x) => x.id === 50)!;
  assert.equal(u.drone, true, "the Firefly is flagged as a carrier drone");
  assert.ok(!model.feedData.some((f) => f.cls === "death" && /Firefly/.test(f.txt)),
    "a drone death leaves no feed row");
  assert.ok(model.feedData.some((f) => f.cls === "death"),
    "non-drone deaths keep their rows");
  // chicken-mode drones are genuine combat units and stay fed
  snap.unitDefs.set(51, { defID: 51, name: "chicken_drone", metalCost: 20, health: 40, canMove: true, iconType: "chicken", humanName: "Hopper" });
  snap.units.set(51, { unitID: 51, defID: 51, samples: [
    { frame: 6, x: 3000, z: 3000, hp: 255, build: 255 },
    { frame: 300, x: 3100, z: 3100, hp: 0, build: 255 },
  ] });
  snap.events.push(
    { kind: "spawn", frame: 6, unitID: 51, int1: 51, int2: 0, int3: -1 },
    { kind: "death", frame: 312, unitID: 51, int1: 1, int2: 0, int3: -1 },
  );
  const zkr2 = buildZkrFromResim(snap, { projectiles: "heavy" });
  const model2 = ZkrReplay.artifactToModel(await ZkrReplay.parse(new Uint8Array(Buffer.from(zkr2))));
  assert.ok(model2.feedData.some((f) => f.cls === "death" && /Hopper/.test(f.txt)),
    "chicken drones are real combat units and stay in the feed");
});

test("iconSize reads ZK's per-iconType size table", () => {
  assert.equal(ZkrReplay.iconSize("stealth"), 1.6, "Scythe: stealth keeps its own 1.6");
  assert.equal(ZkrReplay.iconSize("sniper"), 2.4, "Phantom: sniper is 2.4");
  assert.equal(ZkrReplay.iconSize("cruisemissile"), 2.5, "the Missile Silo icon");
  assert.equal(ZkrReplay.iconSize("cruisemissilesmall"), 1, "stockpiled missiles: half the silo pair");
  assert.equal(ZkrReplay.iconSize("nuke"), 3, "Trinity silo");
  assert.equal(ZkrReplay.iconSize("none"), 2, "untabled iconTypes read as the neutral 2.0");
  assert.equal(ZkrReplay.iconSize(undefined), 2, "no iconType at all: neutral");
});


test("unitValueClass buckets defs into econ/other/combat for the stats grid", () => {
  assert.equal(ZkrReplay.unitValueClass("energysolar", "energy_med"), "econ");
  assert.equal(ZkrReplay.unitValueClass("staticmex", "mex"), "econ");
  assert.equal(ZkrReplay.unitValueClass("estorage", "storage"), "econ");
  assert.equal(ZkrReplay.unitValueClass("factoryspider", "facspider"), "other");
  assert.equal(ZkrReplay.unitValueClass("striderhub", "t3hub"), "other");
  assert.equal(ZkrReplay.unitValueClass("cloakjammer", "kbotjammer"), "other");
  assert.equal(ZkrReplay.unitValueClass("staticradar", "radar"), "other");
  assert.equal(ZkrReplay.unitValueClass("dyntrainer_assault_base", "commander1"), "other");
  assert.equal(ZkrReplay.unitValueClass("cloakraid", "kbotraider"), "combat");
  assert.equal(ZkrReplay.unitValueClass("turretaaclose", "defenseaa"), "combat");
  assert.equal(ZkrReplay.unitValueClass("funnelweb", "mobiletachyon"), "combat");
});

test("autohost polls parse into votes: counts, resolution, per-poll voter attribution", () => {
  // exact shapes observed in the real demo's relayed chat: Poll state lines
  // end with [!y=a/b, !n=c/d] or [END:...]; players cast with "!vote 1|2"
  const artifact = {
    containerVersion: 1, sections: [],
    meta: { schema: 1, gameTime: 600, map: { name: "M", dims: [10000, 9000] } },
    chat: [
      [1000, 6, 254, "SPRINGIE:<ninse>!poll resign"],
      [1100, 255, 254, "Poll: Resign team 2? [!y=0/3, !n=0/3]"],
      [1200, 6, 254, "!vote 1"],
      [1300, 3, 254, "!vote 2"],
      [1400, 255, 254, "Poll: Resign team 2? [!y=1/3, !n=1/3]"],
      [2200, 255, 254, "Poll: Resign team 2? [!y=3/3, !n=1/3]"],
      [2400, 255, 254, "Poll: Resign team 2? [END:SUCCESS]"],
      [2500, 9, 255, "!vote 1"],        // after resolution: belongs to nothing
      [2700, 255, 254, "Team 2 resigned"],
      // second poll: recasts, then superseded by a third poll mid-run
      [2800, 255, 254, "Poll: Kick hallo hallo? [!y=0/2, !n=0/2]"],
      [2900, 6, 254, "!vote 2"],
      [2950, 6, 254, "!vote 1"],        // ninse recasts yes (ZK keeps the last cast)
      [3000, 3, 254, "!vote 1"],        // hallohallo votes yes too
      [3100, 255, 254, "Poll: Exit the game [!y=0/9, !n=0/9]"],   // supersedes
      // third poll never resolves: stays endTm-null (unresolved), no feed line
    ],
    roster: {
      players: [
        { name: "ninse", script: "player6", team: 3, spectator: false },
        { name: "hallohallo", script: "player3", team: 5, spectator: false },
      ],
      teams: [{ num: 3, allyteam: 1 }, { num: 5, allyteam: 1 }],
    },
    metalSpots: { schema: 1, spots: [[2816, 2816, 2], [1000, 7777, 1.5]] },
  };
  const model = ZkrReplay.artifactToModel(artifact as never);
  assert.equal(model.votes.length, 3, "one poll per subject: resolved, superseded, unresolved");
  const v = model.votes[0]!;
  assert.equal(v.subject, "Resign team 2");
  assert.equal(v.yes, 3);
  assert.equal(v.no, 1);
  assert.equal(v.needed, 3);
  assert.equal(v.success, true);
  assert.ok(Math.abs(v.startTm - 1100 / 30) < 1e-6, "poll starts at its first state line");
  assert.ok(Math.abs(v.endTm - 2400 / 30) < 1e-6, "poll ends at its END line");
  assert.equal(v.voters.length, 2, "votes cast while the poll ran are attributed");
  assert.equal(v.voters.find((x) => x.yes)!.name, "ninse", "!vote 1 line carries the caster's name");
  assert.equal(v.voters.find((x) => !x.yes)!.name, "hallohallo");
  assert.ok(!v.voters.some((x) => x.tm > v.endTm), "a vote after resolution never joins the poll");
  assert.ok(model.feedData.some((f) => f.cls === "vote" && /Resign team 2 — passed/.test(f.txt)),
    "resolved poll leaves a feed line");

  // superseded poll: a new subject cutting in resolves the previous one,
  // success unknown — neither "passed" nor "failed" lands in the feed
  const v2 = model.votes[1]!;
  assert.equal(v2.subject, "Kick hallo hallo");
  assert.ok(Math.abs(v2.endTm! - 3100 / 30) < 1e-6, "superseded poll ends at the next poll's first state line");
  assert.equal(v2.success, undefined);
  assert.equal(v2.voters.length, 3, "recasts are ALL recorded raw; the card's last-cast rule is render-side");
  assert.ok(model.feedData.some((f) => f.cls === "vote" && /Kick hallo hallo — ended/.test(f.txt)),
    "superseded poll closes with an ENDED feed line, never passed/failed");

  // unresolved poll: endTm null (NEVER a negative sentinel — pre-game polls
  // resolve with genuinely negative times and would pin a card forever)
  const v3 = model.votes[2]!;
  assert.equal(v3.subject, "Exit the game");
  assert.strictEqual(v3.endTm, null, "never-resolved poll keeps the null sentinel");
  assert.ok(!model.feedData.some((f) => f.cls === "vote" && /Exit the game/.test(f.txt)),
    "unresolved poll leaves no feed line");

  // metal spots normalize to map fractions
  assert.equal(model.metalSpots.length, 2);
  assert.ok(Math.abs(model.metalSpots[0]!.x - 0.2816) < 1e-6);
  assert.ok(Math.abs(model.metalSpots[1]!.y - 7777 / 9000) < 1e-6);
});

test("model.players carries every roster player's elo/level with command counts", () => {
  // mirrors the real demo: 10 players, three spectators, each player their
  // own team; the old hardcoded table dropped four players' elo
  const artifact = {
    containerVersion: 1, sections: [],
    meta: { schema: 1, gameTime: 100, map: { name: "M", dims: [16384, 16384] } },
    roster: {
      players: [
        { name: "Sarathos", elo: 2591, level: 93, spectator: true, script: "player0" },
        { name: "Boetvaardig", elo: 2216, level: 79, team: 0, spectator: false, script: "player1" },
        { name: "kurikurin", elo: 1515, level: 4, team: 1, spectator: false, script: "player2" },
        { name: "hallohallo", elo: 2045, level: 71, team: 2, spectator: false, script: "player3" },
        { name: "WM1enjoyer", elo: 1156, level: 31, team: 6, spectator: false, script: "player9", clan: "RSMC" },
      ],
      teams: [
        { num: 0, allyteam: 0 }, { num: 1, allyteam: 0 },
        { num: 2, allyteam: 0 }, { num: 6, allyteam: 1 },
      ],
      allyteams: [], modoptions: null,
    },
    psta: [
      { index: 1, numCommands: 566 },
      { index: 2, numCommands: 1380 },
      { index: 3, numCommands: 889 },
      { index: 9, numCommands: 1435 },
    ],
    unitDefs: { units: [] }, weaponDefs: null, chat: null, eco: null, link: null,
    proj: null, evnt: { records: [], maxFrame: 0 },
    pos: { units: [], maxFrame: 0 },
  };
  const model = ZkrReplay.artifactToModel(artifact as never);
  assert.equal(model.players.length, 4, "spectators are not team-table players");
  const byName = new Map(model.players.map((p: { name: string }) => [p.name, p]));
  assert.equal(byName.get("Boetvaardig")!.elo, 2216);
  assert.equal(byName.get("kurikurin")!.elo, 1515, "kurikurin's elo must not be '—' anymore");
  assert.equal(byName.get("hallohallo")!.elo, 2045);
  assert.equal(byName.get("WM1enjoyer")!.elo, 1156, "WM1enjoyer's elo must not be '—' anymore");
  assert.equal(byName.get("WM1enjoyer")!.clan, "RSMC");
  assert.equal(byName.get("kurikurin")!.cmds, 1380, "commands joined from PSTAT by playerNum");
  assert.equal(byName.get("Boetvaardig")!.ally, 0);
  assert.equal(byName.get("WM1enjoyer")!.ally, 1);
  // sorted by allyteam then team: the first three rows are allyteam 0
  assert.ok(model.players.findIndex((p: { name: string }) => p.name === "WM1enjoyer") === 3);
});

test("mapFitRect contain-fits the map at its true aspect ratio", () => {
  // The Hole is square: in a wide 16:9 panel it must letterbox, not stretch
  const sq = ZkrReplay.mapFitRect(16384, 16384, 1600, 900);
  assert.equal(sq.fw, 900, "square map fits to the panel height");
  assert.equal(sq.fh, 900);
  assert.equal(sq.ox, 350, "equal side bars");
  assert.equal(sq.oy, 0);
  // Otago is wide: in a square panel it letterboxes top/bottom
  const wide = ZkrReplay.mapFitRect(32768, 16384, 900, 900);
  assert.equal(wide.fw, 900);
  assert.equal(wide.fh, 450);
  assert.equal(wide.ox, 0);
  assert.equal(wide.oy, 225);
  // wide map in an exactly-matching panel fills it edge to edge
  const exact = ZkrReplay.mapFitRect(32768, 16384, 1600, 800);
  assert.deepEqual({ ox: exact.ox, oy: exact.oy, fw: exact.fw, fh: exact.fh },
    { ox: 0, oy: 0, fw: 1600, fh: 800 });
  // missing dims (synthetic fixtures) fall back to a square fit
  const fb = ZkrReplay.mapFitRect(0, 0, 800, 500);
  assert.equal(fb.fw, 500);
  assert.equal(fb.fh, 500);
  assert.equal(fb.ox, 150);
});

test("engagement rows decode into per-attacker arrow sessions with engAt TTL", async () => {
  const snap = syntheticSnapshot();
  // two glaives and a bandit: units 1 and 2 exist in the base fixture
  snap.unitDefs.set(11, { defID: 11, name: "bandit", metalCost: 130, health: 90, canMove: true, iconType: "raider3", humanName: "Bandit" });
  snap.units.set(30, { unitID: 30, defID: 11, samples: [
    { frame: 6, x: 4000, z: 4000, hp: 255, build: 255 },
    { frame: 600, x: 4000, z: 4000, hp: 255, build: 255 },
  ] });
  snap.events.push({ kind: "spawn", frame: 6, unitID: 30, int1: 11, int2: 1, int3: -1 });
  // attacker 30 (bandit) fights unit 1 from frame 100, switches to unit 2
  // at 400, refreshes the pair at 520, then goes quiet
  snap.events.push({ kind: "engage", frame: 100, unitID: 30, int1: 1, int2: -1, int3: -1 });
  snap.events.push({ kind: "engage", frame: 400, unitID: 30, int1: 2, int2: -1, int3: -1 });
  snap.events.push({ kind: "engage", frame: 520, unitID: 30, int1: 2, int2: -1, int3: -1 });
  const zkr = buildZkrFromResim(snap, { projectiles: "heavy" });
  const model = ZkrReplay.artifactToModel(await ZkrReplay.parse(new Uint8Array(Buffer.from(zkr))));

  const rows = model.engagements[30];
  assert.ok(rows && rows.length === 3, "three engage rows survive pack/decode");
  assert.equal(rows[0]!.v, 1);
  assert.equal(rows[1]!.v, 2);
  assert.ok(Math.abs(rows[0]!.t - 100 / 30) < 0.01, "frame -> sim seconds");

  const TTL = model.ENGAGE_TTL;
  // before the first recorded hit: nothing
  assert.equal(ZkrReplay.engAt(rows, 2, TTL), null, "no target before the first hit");
  // mid-fight: current victim follows the latest row at-or-before tm
  assert.equal(ZkrReplay.engAt(rows, 100 / 30 + 0.3, TTL)!.v, 1, "victim 1 mid-fight");
  assert.equal(ZkrReplay.engAt(rows, 400 / 30 + 0.05, TTL)!.v, 2, "switch to victim 2");
  assert.equal(ZkrReplay.engAt(rows, 520 / 30 + 0.2, TTL)!.v, 2, "keep-alive refresh holds the pair");
  // past the TTL after the last refresh: the fight went quiet
  assert.equal(ZkrReplay.engAt(rows, 520 / 30 + TTL + 0.01, TTL), null, "arrow expires past the TTL");
  // custom ttl (the page may tighten the window)
  assert.equal(ZkrReplay.engAt(rows, 520 / 30 + 0.7, 0.5), null, "shorter ttl expires sooner");
  // units with no engagements carry no entry; no other attacker keys appear
  assert.equal(Object.keys(model.engagements).length, 1);
});

test("EMP impacts: beam rings anchor at the struck unit, Paladin rockets ring at their target", async () => {
  const snap = syntheticSnapshot();
  // a Scorpion (team 0) parked at (3000,3000), striking a Bandit (team 1)
  // parked far away at (9000,9000)
  snap.unitDefs.set(70, { defID: 70, name: "striderscorpion", metalCost: 3000, health: 8000, canMove: true, iconType: "t3riot", humanName: "Scorpion" });
  snap.units.set(70, { unitID: 70, defID: 70, samples: [
    { frame: 6, x: 3000, z: 3000, hp: 255, build: 255 },
    { frame: 1200, x: 3000, z: 3000, hp: 255, build: 255 },
  ] });
  snap.events.push({ kind: "spawn", frame: 6, unitID: 70, int1: 70, int2: 0, int3: -1 });
  snap.unitDefs.set(71, { defID: 71, name: "bandit", metalCost: 130, health: 90, canMove: true, iconType: "raider3", humanName: "Bandit" });
  snap.units.set(71, { unitID: 71, defID: 71, samples: [
    { frame: 6, x: 9000, z: 9000, hp: 255, build: 255 },
    { frame: 1200, x: 9000, z: 9000, hp: 255, build: 255 },
  ] });
  snap.events.push({ kind: "spawn", frame: 6, unitID: 71, int1: 71, int2: 1, int3: -1 });
  // the scorpion's multi-stunner hits the bandit at frame 300
  snap.events.push({ kind: "engage", frame: 300, unitID: 70, int1: 71, int2: -1, int3: -1 });
  // the beam flight: zero-span, both samples AT the muzzle - the old code
  // anchored the ring here (the scorpion's own icon)
  snap.weaponDefs.set(45, { defID: 45, name: "striderscorpion_multilightning", type: "LightningCannon", range: 490, aoe: 80 });
  snap.projectiles.set(300, { proID: 300, weaponDefID: 45, projClass: 1, ownerTeam: 0, startFrame: 300,
    samples: [{ frame: 300, x: 3000, z: 3000, y: 30 }, { frame: 306, x: 3000, z: 3000, y: 30 }] });
  // the Paladin's EMP rockets: a real missile flight, impact at its last
  // sample (12 frames apart - a wider gap would SPLIT into two flights at
  // the packer's 18-frame rule and ring the muzzle fragment too)
  snap.weaponDefs.set(46, { defID: 46, name: "striderbantha_emp_missile", type: "MissileLauncher", range: 1200, aoe: 64 });
  snap.projectiles.set(301, { proID: 301, weaponDefID: 46, projClass: 4, ownerTeam: 1, startFrame: 400,
    samples: [{ frame: 400, x: 4000, z: 4000, y: 200 }, { frame: 412, x: 11000, z: 11000, y: 0 }] });
  // a second scorpion beam: same firer still engaged with the same victim -
  // it rings at the victim too (the scorpion simply shot again)
  snap.projectiles.set(302, { proID: 302, weaponDefID: 45, projClass: 1, ownerTeam: 0, startFrame: 500,
    samples: [{ frame: 500, x: 3100, z: 3100, y: 30 }] });
  // a beam from the fencer (team 0, unit 1 - it has NO engagement rows and
  // the scorpion is far outside the muzzle radius): NO ring at all
  snap.projectiles.set(303, { proID: 303, weaponDefID: 45, projClass: 1, ownerTeam: 0, startFrame: 500,
    samples: [{ frame: 500, x: 1100, z: 2100, y: 30 }] });
  const zkr = buildZkrFromResim(snap, { projectiles: "heavy" });
  const model = ZkrReplay.artifactToModel(await ZkrReplay.parse(new Uint8Array(Buffer.from(zkr))));

  const cyan = model.explosions.filter((e) => e.col === "72,214,255");
  assert.equal(cyan.length, 3,
    "three EMP rings: both scorpion shots (anchored at the victim) and the rockets - the fencer's anchorless beam paints none");
  const beamRings = cyan.filter((e) => e.r === 80);
  assert.equal(beamRings.length, 2, "both scorpion beams ring");
  for (const beamRing of beamRings) {
    assert.ok(Math.abs(beamRing.x - 9000 / 16384) < 1e-4 && Math.abs(beamRing.y - 9000 / 16384) < 1e-4,
      "the multi-stunner ring lands at the STRUCK bandit, not at the scorpion's muzzle");
  }
  assert.ok(Math.abs(beamRings[0]!.x - 3000 / 16384) > 0.1, "sanity: the old wrong anchor (the muzzle) is far away");
  const rocketRing = cyan.find((e) => e.r === 64)!;
  assert.ok(Math.abs(rocketRing.x - 11000 / 16384) < 1e-4 && Math.abs(rocketRing.y - 11000 / 16384) < 1e-4,
    "the Paladin's EMP rockets ring at their impact (the last flight sample)");
});
