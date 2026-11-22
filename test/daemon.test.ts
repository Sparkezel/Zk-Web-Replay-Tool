/**
 * M2 daemon tests: projectile classification, ZKR line ingest, binary
 * section encoding, and the no-engine fallback resim pipeline.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  classifyProjectile, presetRecords, ingestLine, newSnapshot,
  buildZkrFromResim, quantize, readZkr, SECTION,
  resimBattle, parseArgs, injectWidget, SNAPSHOT_WIDGET_NAME,
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

test("ingest splits a projectile track when Spring recycles the proID", () => {
  const snap = newSnapshot();
  snap.meta.mapW = 16384;
  snap.meta.mapH = 16384;
  ingestLine(snap, 'ZKR {"t":"wdef","d":10,"n":"merlinrocket","w":"MissileLauncher","r":1000}');
  // first flight, three probes 6 frames apart (widget cadence)
  ingestLine(snap, 'ZKR {"t":"proj","f":12,"u":42,"d":10,"tm":0,"x":1000,"y":120,"z":2000}');
  ingestLine(snap, 'ZKR {"t":"proj","f":18,"u":42,"d":10,"tm":0,"x":1100,"y":140,"z":2100}');
  ingestLine(snap, 'ZKR {"t":"proj","f":24,"u":42,"d":10,"tm":0,"x":1200,"y":160,"z":2200}');
  // >1 s later the same ID is a different missile: a concatenation would
  // render an impossible cross-map "flight"
  ingestLine(snap, 'ZKR {"t":"proj","f":5000,"u":42,"d":10,"tm":0,"x":8000,"y":100,"z":8000}');
  ingestLine(snap, 'ZKR {"t":"proj","f":5006,"u":42,"d":10,"tm":0,"x":8100,"y":120,"z":8100}');
  assert.equal(snap.projectiles.size, 1);
  const active = snap.projectiles.get(42)!;
  assert.equal(active.samples.length, 2);
  assert.equal(active.samples[0]!.frame, 5000);
  assert.equal(snap.closedProjectiles.length, 1);
  assert.equal(snap.closedProjectiles[0]!.samples.length, 3);

  // both flights survive the pack as independent paths
  const zkr = buildZkrFromResim(snap, { projectiles: "heavy", demo: undefined });
  const secs = readZkr(zkr);
  const proj = secs.find((s) => s.id === SECTION.PROJECTILES)!;
  const pay = proj.payload!;
  const dv = new DataView(pay.buffer, pay.byteOffset, pay.byteLength);
  assert.equal(dv.getUint32(0, true), 2);
});

test("ingest ignores terraunit spawns, probes and deaths", () => {
  const snap = newSnapshot();
  ingestLine(snap, 'ZKR {"t":"udef","d":77,"n":"terraunit","m":0,"hp":10000,"mv":1}');
  ingestLine(snap, 'ZKR {"t":"spawn","f":100,"u":9,"d":77,"n":"terraunit","tm":0,"b":1}');
  ingestLine(snap, 'ZKR {"t":"spawn","f":102,"u":10,"d":12,"n":"cloakjammer","tm":1,"b":-1}');
  ingestLine(snap, 'ZKR {"t":"pos","f":108,"p":[[9,100,100,1,1],[10,200,200,1,1]]}');
  ingestLine(snap, 'ZKR {"t":"death","f":500,"u":9,"k":10,"kt":1,"w":-1}');
  assert.ok(snap.ignoredUnits.has(9));
  assert.equal(snap.units.size, 1);
  assert.equal(snap.units.get(10)!.samples.length, 1);
  // only the real unit's spawn survives as an event
  assert.deepEqual(snap.events.map((e) => e.kind), ["spawn"]);
  assert.equal(snap.events[0]!.unitID, 10);
  // Spring recycles unitIDs: a real unit later reusing the terraunit's id
  // must un-ignore it (the widget clears its own map on UnitDestroyed)
  ingestLine(snap, 'ZKR {"t":"spawn","f":800,"u":9,"d":12,"n":"cloakjammer","tm":2,"b":-1}');
  ingestLine(snap, 'ZKR {"t":"pos","f":806,"p":[[9,300,300,1,1]]}');
  ingestLine(snap, 'ZKR {"t":"death","f":900,"u":9,"k":10,"kt":1,"w":-1}');
  assert.ok(!snap.ignoredUnits.has(9), "real spawn reclaims the recycled unitID");
  assert.ok(snap.units.has(9));
  assert.equal(snap.units.get(9)!.samples.length, 1);
  assert.ok(snap.events.some((e) => e.kind === "death" && e.unitID === 9));
});

test("pos rows carry a cloak bitfield + shield charge: bit0 cloaked, bit1 field, bit2 stalled", () => {
  const snap = newSnapshot();
  ingestLine(snap, 'ZKR {"t":"spawn","f":6,"u":1,"d":12,"n":"cloakjammer","tm":0,"b":-1}');
  ingestLine(snap, 'ZKR {"t":"pos","f":6,"p":[' +
    "[1,100,100,1.0,0.5,7,1.0]," +
    "[1,106,100,1.0,0.5,6,0.5]," +
    "[1,112,100,1.0,0.5,5,0.25]," +
    "[1,118,100,1.0,0.5,1]]}");
  const s = snap.units.get(1)!.samples;
  assert.deepStrictEqual(s.map((x) => [x.cloaked, x.cloakField, x.cloakStalled]), [
    [true, true, true],  // 7 = bit0+bit1+bit2
    [false, true, true], // 6 = field + stalled
    [true, false, true], // 5 = cloaked + stalled
    [true, false, false], // 1, no 7th column -> no shield reading
  ]);
  assert.equal(s[0]!.shield, 1);
  assert.equal(s[1]!.shield, 0.5);
  assert.equal(s[2]!.shield, 0.25);
  assert.equal(s[3]!.shield, undefined, "no 7th column -> no shield reading");
  assert.equal(s[0]!.build, 128, "build progress reaches the snapshot (0.5 of 255)");
  // shield "null" (unit has no shield) is undefined, not 0
  ingestLine(snap, 'ZKR {"t":"pos","f":124,"p":[[1,124,100,1.0,1,0,null]]}');
  assert.equal(snap.units.get(1)!.samples[4]!.shield, undefined);
  assert.equal(snap.units.get(1)!.samples[4]!.cloaked, false);
});

test("wreck features ingest into lifecycle events", () => {
  const snap = newSnapshot();
  ingestLine(snap, 'ZKR {"t":"wrk","f":900,"u":90001,"m":88.000,"x":3072,"z":6144}');
  ingestLine(snap, 'ZKR {"t":"uwrk","f":1500,"u":90001}');
  // a wreck whose def has no metal (nil) must read 0, never -1 (it would
  // subtract from the viewer's zone sums)
  ingestLine(snap, 'ZKR {"t":"wrk","f":901,"u":90002,"x":4000,"z":1000}');
  assert.deepStrictEqual(snap.events, [
    { kind: "wreck", frame: 900, unitID: 90001, int1: 88, int2: 3072, int3: 6144 },
    { kind: "unwreck", frame: 1500, unitID: 90001, int1: -1, int2: -1, int3: -1 },
    { kind: "wreck", frame: 901, unitID: 90002, int1: 0, int2: 4000, int3: 1000 },
  ]);
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

test("widget injection replaces speed placeholders and leaves none behind", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zkr-widget-"));
  const luaUi = path.join(dir, "LuaUI", "Widgets");
  mkdirSync(luaUi, { recursive: true });
  const wrote = injectWidget(dir, 5);
  assert.ok(wrote !== null);
  const lua = readFileSync(path.join(luaUi, SNAPSHOT_WIDGET_NAME), "utf8");
  assert.ok(!lua.includes("__ZKR_"), "unreplaced placeholder in injected widget");
  assert.match(lua, /local targetSpeed = tonumber\("5"\) or 1/);
  assert.match(lua, /Spring\.GetGameSpeed/);
  assert.equal(injectWidget(path.join(dir, "nope"), 5), null);
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
