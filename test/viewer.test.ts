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
  const mid = ZkrReplay.trackAt(u1.track, 7 / 30);
  assert.ok(Math.abs(mid!.x - 1124.5 / 16384) < 0.001);
  assert.ok(Math.abs(mid!.hp - 0.8) < 0.02);
});
