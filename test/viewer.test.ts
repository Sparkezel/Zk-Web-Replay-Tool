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

test("POS v2 keeps true sample timing (probe gaps) and the cloak bit", async () => {
  // irregular gaps are the point: v1 threw the cadence away and decoders
  // wrongly assumed one sample per frame, compressing unit motion to 1/6
  const snap = syntheticSnapshot();
  const u = snap.units.get(1)!;
  u.samples = [
    { frame: 6, x: 1024.5, z: 2048.25, hp: 255, build: 255, cloaked: true },
    { frame: 13, x: 1090, z: 2100, hp: 255, build: 255, cloaked: true },
    { frame: 25, x: 1200, z: 2200, hp: 255, build: 255 },
  ];
  const zkr = buildZkrFromResim(snap, { projectiles: "heavy" });
  const artifact = await ZkrReplay.parse(new Uint8Array(Buffer.from(zkr)));
  const posUnit = artifact.pos!.units.find((x) => x.unitID === 1)!;
  assert.deepEqual(posUnit.samples.map((s) => s.frame), [6, 13, 25]);
  assert.deepEqual(posUnit.samples.map((s) => s.ck), [true, true, false]);
  const model = ZkrReplay.artifactToModel(artifact);
  const m = model.units.find((x) => x.id === 1)!;
  assert.deepEqual(m.track.map((t) => Math.round(t.t * 30)), [6, 13, 25]);
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
