/**
 * Diagnostics: decode a real .zkr artifact exactly the way the mockup viewer
 * does and dump what the renderer would show. Not shipped, not tested — a
 * debugging aid for artifact/viewer mismatch reports.
 *
 *   node scripts/inspect-zkr.mjs [artifactPath]   (default mockup/battle.zkr)
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
await import("../mockup/replay.js"); // IIFE that sets globalThis.ZkrReplay
const ZkrReplay = globalThis.ZkrReplay;

const path = process.argv[2] ?? "mockup/battle.zkr";
const buf = readFileSync(path);
const a = await ZkrReplay.parse(new Uint8Array(buf));

console.log(`== ${path} (${buf.length} bytes, container v${a.containerVersion}) ==`);
for (const s of a.sections) console.log(`  ${s.id} v${s.version} codec=${s.codec} raw=${s.uncompressedSize}`);

const m = ZkrReplay.artifactToModel(a);
console.log(`MODEL: units=${m.units.length} projectiles=${m.projectiles.length} links=${m.links.length} END=${m.END.toFixed(1)}s (=frame ${Math.round(m.END * 30)})`);
console.log(`       winner=${JSON.stringify(m.winner)} map=${JSON.stringify(m.mapName)}`);

// EVNT breakdown
const kinds = {};
for (const r of (a.evnt ? a.evnt.records : [])) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
console.log("EVNT:", JSON.stringify(kinds));
if (a.evnt && a.evnt.records.length) {
  const fr = a.evnt.records.map((r) => r.frame);
  console.log(`  frames: min=${Math.min(...fr)} max=${Math.max(...fr)}`);
}

// POS track shape
if (a.pos) {
  const u = a.pos.units;
  const lens = u.map((x) => x.samples.length).sort((p, q) => p - q);
  const firsts = u.map((x) => x.firstFrame).sort((p, q) => p - q);
  const lasts = u.map((x) => x.firstFrame + x.samples.length).sort((p, q) => p - q);
  const q = (arr, f) => arr[Math.min(arr.length - 1, Math.floor(arr.length * f))];
  console.log(`POS: units=${u.length} maxFrame=${a.pos.maxFrame}`);
  console.log(`  samples/track: min=${lens[0]} p50=${q(lens, .5)} p90=${q(lens, .9)} max=${lens[lens.length - 1]}`);
  console.log(`  firstFrame:   min=${firsts[0]} p50=${q(firsts, .5)} p90=${q(firsts, .9)} max=${firsts[firsts.length - 1]}`);
  console.log(`  lastFrame:    min=${lasts[0]} p50=${q(lasts, .5)} p90=${q(lasts, .9)} max=${lasts[lasts.length - 1]}`);
}

// what the renderer would show at sample times (index.html visibility rules)
const deathByUnit = new Map(m.units.map((u) => [u.id, u.died]));
function visibleAt(tm) {
  const vis = [];
  for (const u of m.units) {
    if (tm < u.born) continue;
    if (u.died > 0 && tm >= u.died) continue;
    const s = ZkrReplay.trackAt(u.track, tm);
    if (!s) continue;
    vis.push(u);
  }
  return vis;
}
// coordinate spread of decoded tracks (all-zero quantization = everything on 1 px)
{
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, zeroX = 0, zeroY = 0, n = 0;
  for (const u of m.units) for (const s of u.track) {
    n++;
    if (s.x < minX) minX = s.x; if (s.x > maxX) maxX = s.x;
    if (s.y < minY) minY = s.y; if (s.y > maxY) maxY = s.y;
    if (s.x === 0) zeroX++; if (s.y === 0) zeroY++;
  }
  console.log(`coords: samples=${n} x:[${minX.toFixed(4)},${maxX.toFixed(4)}] y:[${minY.toFixed(4)},${maxY.toFixed(4)}] zero@x=${zeroX} zero@y=${zeroY}`);
}
{
  const vis = visibleAt(600);
  const xs = vis.map((u) => ZkrReplay.trackAt(u.track, 600));
  console.log(`t=600s coordinate spread of ${vis.length} visible: x:[${Math.min(...xs.map((p) => p.x)).toFixed(3)},${Math.max(...xs.map((p) => p.x)).toFixed(3)}] y:[${Math.min(...xs.map((p) => p.y)).toFixed(3)},${Math.max(...xs.map((p) => p.y)).toFixed(3)}]`);
}
const times = [0, 5, 30, 120, 300, 600, 900, 1200, 1500, m.END * 0.25, m.END * 0.5, m.END * 0.75, m.END - 1];
for (const tm of times) {
  const vis = visibleAt(tm);
  const ghost = vis.filter((u) => u.died < 0 && tm > u.track[u.track.length - 1].t + 0.01 && u.track[u.track.length - 1].t < m.END - 4);
  console.log(`t=${String(Math.round(tm)).padStart(5)}s: visible=${vis.length}` + (ghost.length ? ` (of which ${ghost.length} ghosts)` : "") + (vis.length ? "  e.g. " + vis.slice(0, 4).map((u) => `#${u.id}/${(m.unitNames.get(u.defID) || {}).name ?? u.defID}`).join(", ") : ""));
}

// units the viewer counts per team (feed of first 30 events)
console.log("first 10 deaths:", m.feedData.slice(0, 10).map((f) => `${f.tm.toFixed(0)}s ${f.txt}`).join(" | "));
console.log("last 5 events:", m.feedData.slice(-5).map((f) => `${f.tm.toFixed(0)}s ${f.txt}`).join(" | "));
