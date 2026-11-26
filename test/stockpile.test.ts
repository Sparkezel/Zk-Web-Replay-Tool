/**
 * Stockpile counters (#47): the widget's stk rows pack into the STCK section
 * and decode into per-unit count tracks; the Missile Silo count comes from
 * the missiles it built.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildZkrFromResim } = require("../dist/daemon/pack.js");
require("../mockup/replay.js");
const ZkrReplay = globalThis.ZkrReplay;

function syntheticSnapshot() {
  return {
    meta: { mapW: 16384, mapH: 16384, engine: "test" },
    units: new Map([
      [1, { unitID: 1, defID: 10, samples: [
        { frame: 6, x: 1024, z: 2048, hp: 255, build: 255 },
        { frame: 2400, x: 1024, z: 2048, hp: 255, build: 255 },
      ] }],
      [2, { unitID: 2, defID: 11, samples: [{ frame: 6, x: 4096, z: 8192, hp: 255, build: 255 }] }],
    ]),
    unitDefs: new Map(),
    weaponDefs: new Map(),
    events: [
      { kind: "spawn", frame: 6, unitID: 1, int1: 10, int2: 0, int3: -1 },
      { kind: "spawn", frame: 6, unitID: 2, int1: 11, int2: 1, int3: -1 },
    ],
    projectiles: new Map(),
    links: new Map(),
    gameOvers: [{ frame: 3000, winners: [0] }],
  };
}

test("stockpile counts: widget stk rows pack into STCK and decode into per-unit tracks (#47)", async () => {
  const { ingestLine } = require("../dist/daemon/events.js");
  const snap = syntheticSnapshot();
  snap.unitDefs.set(10, { defID: 10, name: "staticnuke", metalCost: 3500, health: 4000, canMove: false, iconType: "nuke", humanName: "Trinity" });
  // a Trinity (unit 1) stockpiles two missiles and fires one; one stk line can carry several units
  ingestLine(snap, 'ZKR {"t":"stk","p":[[1,30,0]]}');
  ingestLine(snap, 'ZKR {"t":"stk","p":[[1,600,1],[2,600,3]]}');
  ingestLine(snap, 'ZKR {"t":"stk","p":[[1,900,2]]}');
  ingestLine(snap, 'ZKR {"t":"stk","p":[[1,960,1]]}');
  assert.equal(snap.stockpile.length, 5);
  const zkr = buildZkrFromResim(snap, { projectiles: "heavy" });
  const artifact = await ZkrReplay.parse(new Uint8Array(Buffer.from(zkr)));
  assert.ok(artifact.sections.some((x) => x.id === "STCK"), "STCK section written");
  const model = ZkrReplay.artifactToModel(artifact);
  const trinity = model.units.find((u) => u.id === 1)!;
  const at = (f: number) => ZkrReplay.stockAt(trinity.stock, f / 30);
  assert.deepEqual([at(10), at(599), at(600), at(899), at(900), at(960), at(2000)], [0, 0, 1, 1, 2, 1, 1]);
  assert.equal(ZkrReplay.stockAt(model.units.find((u) => u.id === 2)!.stock, 21), 3);
  assert.equal(ZkrReplay.stockAt(null, 5), 0, "units without a track read 0");
});

test("Missile Silo count comes from the missiles it built: finished, not launched, not dead (#47)", async () => {
  const snap = syntheticSnapshot();
  snap.unitDefs.set(70, { defID: 70, name: "staticmissilesilo", metalCost: 1200, health: 1500, canMove: false, iconType: "cruisemissile", humanName: "Missile Silo" });
  snap.unitDefs.set(71, { defID: 71, name: "tacnuke", metalCost: 0, health: 100, canMove: true, iconType: "cruisemissilesmall", humanName: "Eos" });
  snap.units.set(70, { unitID: 70, defID: 70, samples: [
    { frame: 6, x: 3000, z: 3000, hp: 255, build: 255 },
    { frame: 3000, x: 3000, z: 3000, hp: 255, build: 255 },
  ] });
  snap.events.push({ kind: "spawn", frame: 6, unitID: 70, int1: 70, int2: 0, int3: -1 });
  // missile A: built (frame 300), launched (staging corner sample at 900;
  // stockpiled near the corner so the jump fits the packer's s16 delta)
  snap.units.set(71, { unitID: 71, defID: 71, samples: [
    { frame: 120, x: 12000, z: 2000, hp: 255, build: 100 },
    { frame: 300, x: 12000, z: 2000, hp: 255, build: 255 },
    { frame: 900, x: 16384, z: 0, hp: 255, build: 255 },
  ] });
  snap.events.push({ kind: "spawn", frame: 120, unitID: 71, int1: 71, int2: 0, int3: 70 });
  // missile B: built (frame 600), killed in the silo at 1200
  snap.units.set(72, { unitID: 72, defID: 71, samples: [
    { frame: 400, x: 3000, z: 3000, hp: 255, build: 50 },
    { frame: 600, x: 3000, z: 3000, hp: 255, build: 255 },
    { frame: 1194, x: 3000, z: 3000, hp: 255, build: 255 },
  ] });
  snap.events.push({ kind: "spawn", frame: 400, unitID: 72, int1: 71, int2: 0, int3: 70 });
  snap.events.push({ kind: "death", frame: 1200, unitID: 72, int1: 1, int2: 1, int3: -1 });
  // missile C: still under construction at the end - never counted
  snap.units.set(73, { unitID: 73, defID: 71, samples: [
    { frame: 1500, x: 3000, z: 3000, hp: 255, build: 80 },
  ] });
  snap.events.push({ kind: "spawn", frame: 1500, unitID: 73, int1: 71, int2: 0, int3: 70 });
  const model = ZkrReplay.artifactToModel(await ZkrReplay.parse(new Uint8Array(Buffer.from(buildZkrFromResim(snap, { projectiles: "heavy" })))));
  const silo = model.units.find((u) => u.id === 70)!;
  const at = (f: number) => ZkrReplay.stockAt(silo.stock, f / 30);
  assert.deepEqual([at(200), at(300), at(600), at(899), at(900), at(1199), at(1200), at(2000)], [0, 1, 2, 2, 1, 1, 0, 0]);
});
