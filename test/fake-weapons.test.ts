/**
 * Zero-K's fake weapons (customParams.bogus, or a description starting with
 * "Fake") are never recorded as flights, also when their internal name has no
 * "fake" in it (the Reef's shipcarrier_carriertargeting).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { classifyProjectile } = require("../dist/daemon/classify.js");
const { buildZkrFromResim } = require("../dist/daemon/pack.js");
const { ingestLine, newSnapshot } = require("../dist/daemon/events.js");
require("../mockup/replay.js");
const ZkrReplay = globalThis.ZkrReplay;

const REEF_TARGETING = { name: "shipcarrier_carriertargeting", type: "StarburstLauncher", range: 1000 };

test("classifier: the widget's bogus flag drops a fake weapon whatever its name", () => {
  assert.equal(classifyProjectile({ ...REEF_TARGETING, customParams: { isnuke: "", interceptor: "", bogus: "1" } }), 0);
  // the same weapon without the flag is a missile flight (what main records)
  assert.equal(classifyProjectile({ ...REEF_TARGETING, customParams: { isnuke: "", interceptor: "" } }), 4);
  // a real missile with an empty flag stays a missile
  assert.equal(classifyProjectile({ name: "shipcarrier_disarm_rocket", type: "StarburstLauncher", range: 3000,
    customParams: { isnuke: "", interceptor: "", bogus: "" } }), 4);
});

test("pack: fake-weapon projectile rows never reach the PROJ section", async () => {
  const snap = newSnapshot();
  snap.meta.mapW = 8192;
  snap.meta.mapH = 8192;
  ingestLine(snap, 'ZKR {"t":"wdef","d":70,"n":"shipcarrier_carriertargeting","w":"StarburstLauncher","r":1000.000,"th":0.000,"aoe":8.000,"adr":0.000,"adu":0.000,"nd":0,"cp":{"isnuke":"","interceptor":"","bogus":"1"}}');
  ingestLine(snap, 'ZKR {"t":"wdef","d":71,"n":"shipcarrier_disarm_rocket","w":"StarburstLauncher","r":3000.000,"th":0.000,"aoe":64.000,"adr":0.000,"adu":0.000,"nd":0,"cp":{"isnuke":"","interceptor":"","bogus":""}}');
  for (const [f, x] of [[30, 1000], [36, 1100]]) {
    ingestLine(snap, `ZKR {"t":"proj","f":${f},"u":500,"d":70,"tm":0,"x":${x},"y":200,"z":1000}`);
    ingestLine(snap, `ZKR {"t":"proj","f":${f},"u":501,"d":71,"tm":0,"x":${x},"y":300,"z":2000}`);
  }
  const art = await ZkrReplay.parse(new Uint8Array(Buffer.from(buildZkrFromResim(snap, { projectiles: "heavy" }))));
  const kept = art.proj.paths.map((p: { weaponDefID: number }) => p.weaponDefID).sort();
  assert.deepEqual(kept, [71], "only the real Disarm Missile flight is packed");
});
