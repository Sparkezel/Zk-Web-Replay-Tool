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
