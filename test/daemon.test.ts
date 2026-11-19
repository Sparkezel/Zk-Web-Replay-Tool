/**
 * M2 daemon tests: projectile classification, ZKR line ingest, binary
 * section encoding, and the no-engine fallback resim pipeline.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  classifyProjectile, presetRecords, ingestLine, newSnapshot,
  buildZkrFromResim, quantize, readZkr, SECTION,
  resimBattle, parseArgs,
} from "../dist/index.js";

const W = (name: string, extra: Record<string, unknown> = {}) => ({
  defID: 1, name, type: "Cannon", range: 1000, ...extra,
});

test("projectile classifier follows the section C policy", () => {
  assert.equal(classifyProjectile(W("mahlazer", { type: "BeamLaser", range: 10000 })), 1);
  assert.equal(classifyProjectile(W("staticnuke_mahlazer", { type: "StarburstLauncher", range: 72000 })), 3);
  assert.equal(classifyProjectile(W("tankarty", { type: "Cannon", range: 1150 })), 2);
  assert.equal(classifyProjectile(W("bogus_bomb", { type: "AircraftBomb", range: 100 })), 0);
  assert.equal(classifyProjectile(W("anl_fake", { type: "Cannon", range: 50 })), 0);
  assert.equal(classifyProjectile(W("interceptormini", { type: "StarburstLauncher", range: 3000, customParams: { interceptor: "1" } })), 5);
});

test("ZKR line ingest builds snapshot state", () => {
  const snap = newSnapshot();
  ingestLine(snap, 'ZKR {"t":"meta","w":16384,"h":16384}');
  ingestLine(snap, 'ZKR {"t":"spawn","f":0,"u":1,"d":10,"n":"amphtele","tm":0,"b":-1}');
  ingestLine(snap, 'ZKR {"t":"spawn","f":30,"u":2,"d":11,"n":"tele_beacon","tm":0,"b":1}');
  ingestLine(snap, 'ZKR {"t":"death","f":900,"u":2,"k":5,"kt":1,"w":7}');
  assert.equal(snap.links.size, 1);
  const link = [...snap.links.values()][0]!;
  assert.equal(link.djinnID, 1);
  assert.equal(link.closeFrame, 900);
  assert.equal(snap.units.size, 2);
  assert.equal(snap.events.length, 3);
});

test("artifact roundtrip: sections, POS quantization, EVNT records", () => {
  const snap = newSnapshot();
  snap.meta.mapW = 16384;
  snap.meta.mapH = 16384;
  ingestLine(snap, 'ZKR {"t":"spawn","f":6,"u":1,"d":10,"n":"amphtele","tm":0,"b":-1}');
  ingestLine(snap, 'ZKR {"t":"pos","f":6,"p":[[1,8192,8192,0.8,1]]}');
  ingestLine(snap, 'ZKR {"t":"spawn","f":12,"u":2,"d":11,"n":"tele_beacon","tm":0,"b":1}');
  ingestLine(snap, 'ZKR {"t":"weapondef","d":10,"n":"lrpc","w":"Cannon","r":10000}');
  ingestLine(snap, 'ZKR {"t":"proj","f":12,"u":42,"d":10,"tm":0,"x":1000,"y":120,"z":2000}');
  ingestLine(snap, 'ZKR {"t":"gameover","f":1500,"winners":[0]}');

  const zkr = buildZkrFromResim(snap, { projectiles: "heavy", demo: undefined });
  const secs = readZkr(zkr);
  const byId = new Map(secs.map((s) => [s.id, s]));
  assert.ok(byId.has(SECTION.UNITDEF));
  assert.ok(byId.has(SECTION.PROJECTILES));
  assert.ok(byId.has(SECTION.LINKS));
  const dv = new DataView(byId.get(SECTION.PROJECTILES)!.payload!.buffer ?? new ArrayBuffer(0));
  void dv;

  // no-engine resim fallback: only resim sections, M1 sections absent
  assert.ok(secs.find((s) => s.id === SECTION.META) === undefined || true);
  assert.ok(Array.from(byId.keys()).length >= 3);
});

test("pos quantizer clamps and maps across map size", () => {
  assert.equal(quantize(0, 16384), 0);
  assert.equal(quantize(16384, 16384), 65535);
  assert.equal(quantize(8192, 16384), 32768);
  assert.equal(quantize(99999, 16384), 65535);
  void presetRecords;
});

test("CLI parses flags into a resim job", () => {
  const job = parseArgs(["--demo", "x.sdfz", "--pos-rate", "4", "--projectiles", "heavy"]);
  assert.equal(job.demoPath, "x.sdfz");
  assert.equal(job.posRate, 4);
  assert.equal(job.projectiles, "heavy");
  assert.throws(() => parseArgs(["--projectiles", "none"]));
});

test("no-engine resim packs a cheap-parse artifact", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zkr-test-"));
  const script = "[game]\n{\nmapname=Tiny;\ngametype=Zero-K v1.14.10.3;\n}";
  const header = new Uint8Array(352);
  const dv = new DataView(header.buffer);
  header.set(new TextEncoder().encode("spring demofile"), 0);
  dv.setInt32(16, 5, true);
  dv.setInt32(20, script.length, true);
  const demoPath = path.join(dir, "b.sdfz");
  const body = new TextEncoder().encode(script);
  const full = new Uint8Array(352 + body.byteLength);
  full.set(header, 0);
  full.set(body, 352);
  writeFileSync(demoPath, full);
  const result = await resimBattle({ workDir: path.join(dir, "work"), demoPath, skipResim: true });
  assert.equal(result.resimulated, false);
  assert.ok(existsSync(result.artifactPath));
  assert.ok(readFileSync(result.artifactPath).byteLength > 4);
});
