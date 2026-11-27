/**
 * Units a Zero-K script hides (a popped Claw mine, a launched silo missile)
 * carry POS flag bit 3; the viewer does not draw them while hidden.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildZkrFromResim } = require("../dist/daemon/pack.js");
const { ingestLine, newSnapshot } = require("../dist/daemon/events.js");
require("../mockup/replay.js");
const ZkrReplay = globalThis.ZkrReplay;

test("hidden flag: widget pos rows -> pack -> decode -> trackAt().hid", async () => {
  const snap = newSnapshot();
  snap.meta.mapW = 16384;
  snap.meta.mapH = 16384;
  ingestLine(snap, 'ZKR {"t":"udef","d":40,"n":"wolverine_mine","m":15,"hp":200,"mv":0,"ic":"mine","hn":"Claw"}');
  ingestLine(snap, 'ZKR {"t":"spawn","f":6,"u":7,"d":40,"n":"wolverine_mine","tm":0,"b":-1}');
  // armed, then popped: the script hides it for 5 s before removing it
  ingestLine(snap, 'ZKR {"t":"pos","f":6,"p":[[7,4000,4000,1.000,1.000,0,null]]}');
  ingestLine(snap, 'ZKR {"t":"pos","f":12,"p":[[7,4000,4000,1.000,1.000,0,null]]}');
  ingestLine(snap, 'ZKR {"t":"pos","f":18,"p":[[7,4000,4000,1.000,1.000,8,null]]}');
  ingestLine(snap, 'ZKR {"t":"pos","f":24,"p":[[7,4000,4000,1.000,1.000,8,null]]}');
  assert.deepEqual(snap.units.get(7).samples.map((s: { hidden?: boolean }) => s.hidden), [false, false, true, true]);
  const model = ZkrReplay.artifactToModel(await ZkrReplay.parse(new Uint8Array(Buffer.from(buildZkrFromResim(snap, {})))));
  const mine = model.units.find((u: { id: number }) => u.id === 7)!;
  assert.equal(ZkrReplay.trackAt(mine.track, 12 / 30).hid, false, "armed mine is drawn");
  assert.equal(ZkrReplay.trackAt(mine.track, 20 / 30).hid, true, "popped mine is hidden");
  assert.equal(ZkrReplay.trackAt(mine.track, 12 / 30).ck, false, "the new bit does not leak into the cloak bit");
});

test("silo missile launch time: the first hidden sample, before the staging corner", async () => {
  const snap = newSnapshot();
  snap.meta.mapW = 16384;
  snap.meta.mapH = 16384;
  ingestLine(snap, 'ZKR {"t":"udef","d":41,"n":"tacnuke","m":0,"hp":100,"mv":1,"ic":"cruisemissilesmall","hn":"Eos"}');
  ingestLine(snap, 'ZKR {"t":"spawn","f":6,"u":8,"d":41,"n":"tacnuke","tm":0,"b":-1}');
  // in the silo, hidden at launch (frame 300, same spot), moved to the staging corner 2 s later
  ingestLine(snap, 'ZKR {"t":"pos","f":294,"p":[[8,12000,2000,1.000,1.000,0,null]]}');
  ingestLine(snap, 'ZKR {"t":"pos","f":300,"p":[[8,12000,2000,1.000,1.000,8,null]]}');
  ingestLine(snap, 'ZKR {"t":"pos","f":306,"p":[[8,12000,2000,1.000,1.000,8,null]]}');
  ingestLine(snap, 'ZKR {"t":"pos","f":360,"p":[[8,16384,0,1.000,1.000,8,null]]}');
  const model = ZkrReplay.artifactToModel(await ZkrReplay.parse(new Uint8Array(Buffer.from(buildZkrFromResim(snap, {})))));
  const eos = model.units.find((u: { id: number }) => u.id === 8)!;
  assert.equal(eos.launched, true);
  assert.ok(Math.abs(eos.launchTm - 300 / 30) < 1e-4, `launch at the hide, not at the corner (got ${eos.launchTm})`);
});
