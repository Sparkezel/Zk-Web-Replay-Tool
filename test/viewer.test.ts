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
      { kind: "death", frame: 900, unitID: 2, int1: 1, int2: 0, int3: 42 },
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
  assert.equal(u1.samples.length, 3);
  assert.ok(Math.abs(u1.samples[0].x - 1024.5 / 16384) < 0.001);
  assert.ok(Math.abs(u1.samples[2].z - 2248.25 / 16384) < 0.001);
  assert.ok(Math.abs(u1.samples[0].hp - 0.9) < 0.01);
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
  const zkr = buildZkrFromResim(syntheticSnapshot(), { projectiles: "heavy" });
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
  assert.ok(hurt.hpMax! - hurt.track[hurt.track.length - 1]!.hp > 0.002,
    "unit 1 ends below its peak, so the ring would draw");
  assert.equal(full.hpMax!, 1);
  assert.ok(full.hpMax! - full.track[0]!.hp <= 0.002,
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
  assert.ok(Math.abs(u1.track[0]!.x - 1024.5 / 16384) < 0.001);
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
  assert.deepEqual(posUnit.samples.map((s) => s.frame), [6, 13, 25]);
  assert.deepEqual(posUnit.samples.map((s) => s.ck), [true, true, true]);
  assert.deepEqual(posUnit.samples.map((s) => s.cf), [true, false, true]);
  assert.deepEqual(posUnit.samples.map((s) => s.cs), [false, true, false]);
  // shield charge byte round-trips at 0..254 resolution, 255 = no shield
  assert.ok(Math.abs(posUnit.samples[0]!.sh! - 1) < 0.01);
  assert.ok(Math.abs(posUnit.samples[1]!.sh! - 0.5) < 0.01);
  assert.equal(posUnit.samples[2]!.sh, undefined, "no shield recorded -> undefined, not 0");
  const model = ZkrReplay.artifactToModel(artifact);
  const m = model.units.find((x) => x.id === 1)!;
  assert.deepEqual(m.track.map((t) => Math.round(t.t * 30)), [6, 13, 25]);
  assert.equal(m.shieldRadius, 350, "UDEF v3 shield radius reaches the model");
  assert.equal(m.shieldPower, 3600);
  assert.deepEqual(m.track.map((t) => t.cs), [false, true, false]);
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
  assert.deepEqual(s.map((x) => x.ck), [true, true]);
  assert.deepEqual(s.map((x) => x.cf), [undefined, undefined],
    "v2 bit1 is NOT a field bit: pre-#13 artifacts would lose all field circles if read");
  const model = ZkrReplay.artifactToModel(artifact);
  const m = model.units[0]!;
  assert.deepEqual(m.track.map((t) => t.cf), [undefined, undefined]);
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
  assert.deepEqual(s.map((x) => x.frame), [100, 106, 112],
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
        samples: [
          { frame: 4810, x: 0.5, z: 0.5, hp: 1, build: 1, ck: true },
          { frame: 4840, x: 0.5, z: 0.5, hp: 1, build: 1 },
        ],
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
  assert.equal(u.track[0]!.ck, true);
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
  const spans = artifact.proj.paths.map((p) => p.samples[p.samples.length - 1].frame - p.startFrame);
  assert.ok(spans.every((s) => s <= 12), "each flight spans a handful of frames, not minutes: " + spans);
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
  assert.ok(Math.abs(first.end - 12 / 30) < 1e-6);
  assert.ok(Math.abs(second.born - 5000 / 30) < 1e-6);
  for (const p of model.projectiles) {
    for (let i = 1; i < p.path.length; i++) {
      assert.ok(p.path[i].t - p.path[i - 1].t <= 0.6, "no cross-map crawl steps");
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
