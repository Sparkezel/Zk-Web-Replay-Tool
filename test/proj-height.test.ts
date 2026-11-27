/**
 * PROJ heights are a 0..65535 fraction of the map's z size, read unsigned:
 * a signed read turned every height above half the map's z size negative.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildZkrFromResim } = require("../dist/daemon/pack.js");
const { ingestLine, newSnapshot } = require("../dist/daemon/events.js");
require("../mockup/replay.js");
const ZkrReplay = globalThis.ZkrReplay;

test("projectile heights above half the map's z size decode as positive", async () => {
  const snap = newSnapshot();
  snap.meta.mapW = 8192;
  snap.meta.mapH = 6144;
  ingestLine(snap, 'ZKR {"t":"wdef","d":80,"n":"zenith_meteor","w":"MissileLauncher","r":8800.000,"th":0.000,"aoe":128.000,"adr":0.000,"adu":0.000,"nd":0,"cp":{"isnuke":"","interceptor":""}}');
  // low, above half the z size (3072), above the z size itself (clamps)
  for (const [f, y] of [[30, 1000], [36, 5000], [42, 9000]]) {
    ingestLine(snap, `ZKR {"t":"proj","f":${f},"u":600,"d":80,"tm":0,"x":4000,"y":${y},"z":3000}`);
  }
  const art = await ZkrReplay.parse(new Uint8Array(Buffer.from(buildZkrFromResim(snap, { projectiles: "heavy" }))));
  const ys = Array.from(art.proj.paths[0].samples.y as Float32Array).slice(1).map((v) => Math.round(v * 6144));
  assert.deepEqual(ys.map((v) => Math.abs(v - [1000, 5000, 6144][ys.indexOf(v)]) <= 1), [true, true, true],
    `decoded heights ${ys} (want 1000, 5000, 6144 clamped)`);
});
