/**
 * Unit-sync diagnostics: for every EVNT spawn compare the spawn frame to the
 * POS track's first/last sample frame; dump ghost (track ended, no death
 * event) lifetimes; show chat frame ranges for pregame detection.
 *   node scripts/inspect-sync.mjs [artifactPath]
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
await import("../mockup/replay.js");
const ZkrReplay = globalThis.ZkrReplay;

const path = process.argv[2] ?? "mockup/battle.zkr";
const buf = readFileSync(path);
const a = await ZkrReplay.parse(new Uint8Array(buf));
const m = ZkrReplay.artifactToModel(a);

const nameOf = (defID) => (m.unitNames.get(defID) || {}).name ?? `def#${defID}`;
const spawnByUnit = new Map();
const deathByUnit = new Map();
for (const r of (a.evnt ? a.evnt.records : [])) {
  if (r.kind === "spawn" && !spawnByUnit.has(r.unitID)) spawnByUnit.set(r.unitID, r);
  if (r.kind === "death") deathByUnit.set(r.unitID, r.frame);
}

// 1) spawn frame vs first POS sample — every unit with a delta > 1s
let worst = [];
for (const u of a.pos.units) {
  const sp = spawnByUnit.get(u.unitID);
  const spF = sp ? sp.frame : null;
  const firstF = u.samples[0]?.frame ?? -1;
  const delta = spF !== null ? firstF - spF : null;
  worst.push({ u: u.unitID, def: nameOf(u.defID), spF, firstF, delta, n: u.samples.length,
    lastF: (u.samples[u.samples.length - 1]?.frame ?? -1), died: deathByUnit.get(u.unitID) ?? null });
}
const delayed = worst.filter((w) => w.delta !== null && w.delta > 30).sort((x, y) => y.delta - x.delta);
console.log(`units with first-sample delayed > 1s after spawn: ${delayed.length}/${worst.length}`);
for (const w of delayed.slice(0, 15)) {
  console.log(`  #${w.u} ${w.def}: spawn@${w.spF} firstSample@${w.firstF} (+${(w.delta / 30).toFixed(1)}s) samples=${w.n} died=${w.died ?? "GHOST"}`);
}
const noSpawn = worst.filter((w) => w.spF === null);
console.log(`units with a POS track but no spawn event: ${noSpawn.length}`);
for (const w of noSpawn.slice(0, 8)) console.log(`  #${w.u} ${w.def} first@${w.firstF} n=${w.n} died=${w.died ?? "GHOST"}`);

// 2) energy structures: per-unit lifecycle
console.log("\n-- energy structures (solar/geo/wind/fusion) --");
for (const w of worst) {
  if (!/solar|geo|wind|fusion/i.test(w.def)) continue;
  const life = w.spF !== null ? ((w.lastF - w.spF) / 30) : null;
  console.log(`  #${w.u} ${w.def} spawn@${w.spF ?? "-"} first@${w.firstF} last@${w.lastF} ` +
    `died@${w.died ?? "GHOST"} trackSpan=${life !== null ? life.toFixed(0) + "s" : "?"} samples=${w.n}`);
}

// 3) ghosts: track ended, no death event — lifetime histogram + kinds
const ghosts = worst.filter((w) => w.died === null && w.lastF >= 0 && w.lastF < a.pos.maxFrame - 120);
console.log(`\nghosts (track ended >4s before POS end, no death): ${ghosts.length}`);
const byDef = {};
for (const g of ghosts) byDef[g.def] = (byDef[g.def] ?? 0) + 1;
console.log("  by def:", JSON.stringify(byDef));
for (const g of ghosts.sort((x, y) => y.lastF - x.lastF).slice(0, 12)) {
  const span = (g.lastF - (g.spF ?? g.firstF)) / 30;
  console.log(`  #${g.u} ${g.def}: first@${g.firstF} last@${g.lastF} → vanished after ${span.toFixed(0)}s of tracking`);
}

// 4) chat frames — pre-game rows relative to the STARTPLAYING anchor
const chat = a.chat ?? [];
const anchor = a.macro?.startPlayingFrame ?? 0;
const frames = chat.map((c) => c[0]);
if (frames.length) {
  console.log(`\nchat rows=${chat.length} frame range: [${Math.min(...frames)} .. ${Math.max(...frames)}] anchor=${anchor}`);
  const pre = chat.filter((c) => c[0] <= anchor);
  console.log(`pre-game (frame<=anchor) rows: ${pre.length}`);
  for (const c of pre.slice(0, 6)) console.log(`  frame ${c[0]} from=${c[1]}: ${String(c[3]).slice(0, 40)}`);
}

// 5) META gameTime + END + maxFrames for cross-section timeline check
console.log(`\nMETA:`, JSON.stringify(a.meta).slice(0, 300));
console.log(`POS maxFrame=${a.pos.maxFrame} EVNT maxFrame=${a.evnt?.maxFrame} model.END=${m.END.toFixed(1)}s`);
