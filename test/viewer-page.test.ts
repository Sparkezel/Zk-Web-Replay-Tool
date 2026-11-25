/**
 * Page-level viewer tests — the deepest gap exposed by the "replay never
 * starts, only two units visible" bug: mockup/index.html's own draw pipeline
 * (buildArtifactModel + draw inside the rAF loop) is never executed by the
 * replay.js parity tests. This file runs the page's inline script headlessly
 * with stubbed DOM/canvas, drives the animation loop and a timeline sweep,
 * and asserts rendering actually happens without exceptions.
 *
 * The rAF loop is fragile by design: any exception in draw()/drawFrame()
 * kills requestAnimationFrame chaining permanently ("Play does nothing") —
 * so "no throw" here is a hard requirement, not style.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildZkrFromResim } = require("../dist/daemon/pack.js");

/* ---------- synthetic battle: an alive unit, a ghost (track ends early,
   no death event) and a killed one — the ghost is what used to crash draw() */
function pageSnapshot() {
  return {
    meta: { mapW: 16384, mapH: 16384, engine: "test" },
    units: new Map([
      [1, { unitID: 1, defID: 10, samples: [
        { frame: 6, x: 1024, z: 2048, hp: 255, build: 255 },
        { frame: 2700, x: 2048, z: 4096, hp: 255, build: 255 },
      ] }],                                     // alive through game end
      [2, { unitID: 2, defID: 11, samples: [
        { frame: 6, x: 8192, z: 8192, hp: 255, build: 255 },
        { frame: 200, x: 8300, z: 8300, hp: 255, build: 255 },
      ] }],                                     // vanished -> ghost wreck
      [3, { unitID: 3, defID: 12, samples: [
        { frame: 6, x: 2048, z: 8192, hp: 255, build: 255 },
      ] }],
    ]),
    unitDefs: new Map([
      [10, { defID: 10, name: "fencer", humanName: "Fencer", metalCost: 220, health: 900, canMove: true, iconType: "moduleshare" }],
      [11, { defID: 11, name: "solar", humanName: "Solar Collector", metalCost: 55, health: 150, canMove: false, iconType: "energysolar" }],
      [12, { defID: 12, name: "staticantinuke", humanName: "Antinuke", metalCost: 900, health: 2000, canMove: false, iconType: "antinuke", antiNukeCoverage: 2500 }],
    ]),
    weaponDefs: new Map(),
    events: [
      { kind: "spawn", frame: 6, unitID: 1, int1: 10, int2: 0, int3: -1 },
      { kind: "spawn", frame: 6, unitID: 2, int1: 11, int2: 0, int3: -1 },
      { kind: "spawn", frame: 6, unitID: 3, int1: 12, int2: 1, int3: -1 },
      { kind: "death", frame: 1500, unitID: 3, int1: 1, int2: 0, int3: 42 },
    ],
    gameOvers: [{ frame: 2700, winners: [0] }],
    projectiles: new Map(),
    links: new Map(),
    /* live states on unit 1 (all three bits + half slow at f200): the draw
       branches for the state dots and the on-fire red flash must run in the
       page harness without throwing */
    states: [
      { unitID: 1, frame: 200, bits: 7, slow: 0.5 },
      { unitID: 4, frame: 100, bits: 4, slow: 0 },
    ],
  };
}

function buildArtifact(dir: string): string {
  const zkr = buildZkrFromResim(pageSnapshot(), { projectiles: "heavy", posRate: 1 });
  const p = path.join(dir, "battle.zkr");
  writeFileSync(p, zkr);
  return p;
}

/* ---------- headless DOM/canvas stubs ---------- */
interface Cx { [k: string]: unknown }
function makeCx(state: { calls: number }): Cx {
  const nul = () => {};
  // browsers: non-finite args are a silent no-op (canvas spec); only arc()
  // with negative radius throws IndexSizeError — mimic exactly that
  const guard = (name: string) => (...args: unknown[]) => {
    state.calls++;
    for (const a of args) {
      if (typeof a === "number" && !Number.isFinite(a)) return; // spec: ignore
    }
    if (name === "arc" && typeof args[2] === "number" && (args[2] as number) < 0) {
      throw new Error("canvas arc() negative radius — IndexSizeError in browsers");
    }
  };
  const t: Cx = { globalAlpha: 1, lineWidth: 1, setLineDash: nul, strokeStyle: "", fillStyle: "" };
  return new Proxy(t, {
    get(o, p) { if (p in o) return o[p]; return guard(String(p)); },
    set(o, p, v) { o[p] = v; return true; },
  });
}

interface SimState { calls: number; raf: Array<(t: number) => void>; time: number }
type El = Record<string, unknown> & {
  id: string;
  checked: boolean;
  textContent: string;
  value: number;
  onclick: ((...a: unknown[]) => void) | null;
  oninput: ((...a: unknown[]) => void) | null;
  onchange: ((...a: unknown[]) => void) | null;
}

function installStubs(serveFile: string | null): { byId: (id: string) => El; state: SimState } {
  const state: SimState = { calls: 0, raf: [], time: 0 };
  const makeEl = (id: string): El => ({
    id, checked: true, textContent: "", innerHTML: "", value: 0, max: 100,
    width: 380, height: 120,        // canvas intrinsic size (markup-defined in the page)
    clientWidth: 800, clientHeight: 460,
    getContext: () => makeCx(state),
    onclick: null, oninput: null, onchange: null,
    classList: { add() {}, remove() {}, contains: () => false },
    children: [] as unknown[],
    querySelector: () => makeEl("q"),
    appendChild(c: unknown) { (this.children as unknown[]).push(c); return c; },
    addEventListener() {},
  });
  const els = new Map<string, El>();
  const byId = (id: string): El => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id)!;
  };
  const g = globalThis as Record<string, unknown>;
  g.document = { getElementById: byId, querySelector: () => makeEl("q"), createElement: (tag: string) => makeEl("dyn-" + tag) };
  g.window = globalThis;
  g.addEventListener = () => {};
  g.Image = class {
    src = "";
    set onload(_: unknown) { /* never fires */ }
    get complete() { return false; }
    get naturalWidth() { return 0; }
    get naturalHeight() { return 0; }
  };
  g.performance = { now: () => state.time };
  g.requestAnimationFrame = (fn: (t: number) => void) => { state.raf.push(fn); return state.raf.length; };
  g.fetch = (_url: unknown) => {
    if (serveFile === null) return Promise.reject(new Error("404"));
    const data = readFileSync(serveFile);
    // Buffer.buffer for small files is Node's shared pool — hand parse() an
    // exact-sized ArrayBuffer like a real fetch response would
    const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(ab) });
  };
  return { byId, state };
}

/** runPage's fixed waits can lose a race against the streamed inflate
 * (parse() awaits a DecompressionStream pipeline with thousands of microtask
 * hops) on slow CI machines — poll for install completion with a deadline
 * instead of betting on wall-clock sleep durations. */
async function waitFor(cond: () => boolean, deadlineMs = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > deadlineMs) return; // let the assert report the stale value
    await new Promise((r) => setTimeout(r, 10));
  }
}

function extractInlineScript(): string {
  const html = readFileSync(path.join("mockup", "index.html"), "utf8");
  const m = /<script>\s*([\s\S]*)<\/script>\s*<\/body>/m.exec(html);
  if (!m) throw new Error("mockup/index.html: inline script not found");
  return m[1]!;
}

/** the old top-right unit counters (cnt1/cnt2 and their labels) must be
 *  gone from the markup after the per-player panel replaced them */
function teamConstantsAreGone(): boolean {
  const html = readFileSync(path.join("mockup", "index.html"), "utf8");
  return !/id="(cnt1|cnt2|t1label|t2label)"/.test(html);
}

/** Run the page script headlessly; drive the rAF loop and a timeline sweep. */
async function runPage(serveFile: string | null): Promise<{ byId: (id: string) => El; state: SimState }> {
  const { byId, state } = installStubs(serveFile);
  await import("../mockup/replay.js"); // sets globalThis.ZkrReplay
  assert.ok((globalThis as Record<string, unknown>).ZkrReplay, "replay.js must set ZkrReplay");
  const src = extractInlineScript();
  // indirect eval: the page script runs in global scope exactly as in a browser
  (0, eval)(src);
  /* the eval tail IIFE kicks off loadReplay(0); wait for installModel
     (every install path writes the chip) instead of a fixed sleep */
  await waitFor(() => byId("chip").textContent !== "");

  // press Play and run ~10 seconds of wall-clock frames
  const playBtn = byId("playBtn");
  assert.equal(typeof playBtn.onclick, "function", "playBtn must have a handler");
  (playBtn.onclick as () => void)();
  for (let i = 0; i < 600; i++) {
    state.time += 16.67;
    const q = state.raf.splice(0);
    for (const fn of q) fn(state.time);
  }
  // full timeline sweep (seek): passes deep into the ghost-unit time range
  const tl = byId("timeline");
  assert.equal(typeof tl.oninput, "function", "timeline must have a handler");
  for (let t = 0; t <= 120; t += 10) {
    tl.value = t;
    (tl.oninput as (e: unknown) => void).call(tl, { target: { value: t } });
  }
  return { byId, state };
}

test("page renders a packed artifact: play + seek survive, units are drawn", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zkr-page-"));
  const artifact = buildArtifact(dir);
  const { byId, state } = await runPage(artifact);

  assert.match(byId("chip").textContent, /rendering battle\.zkr \(\d+ units\)/,
    `artifact model must load (simState says: ${byId("simState").textContent})`);
  assert.ok(state.calls > 1000, `canvas must do real drawing (got ${state.calls} calls)`);
  assert.ok(state.raf.length > 0, "the rAF loop must keep scheduling frames");
  /* frame profiler: drawFrame stamps per-layer segments and profUI renders
     them into the perf panel after its 700 ms window (the fake clock ran
     ~10 s of playback above, so the window has surely lapsed; inside the
     harness each frame's now() calls return the same clock value, so the
     segment times are all 0 ms - the assert checks the PANEL WORKS, not
     the timings) */
  assert.match(byId("perf").innerHTML, /renderer [\d.]+ fps · rAF \d+\/s · avg frame [\d.]+ ms/,
    "profiler renders fps, rAF rate and the avg frame time");
  assert.ok(typeof byId("diag").innerHTML !== "undefined", "diagnostics panel element wired");

  // seek mid-game: unit 2 (ghost: last sample 6.7s, no death event) and the
  // alive units must all draw — the pre-fix page threw right here
  const tl = byId("timeline");
  tl.value = 60;
  (tl.oninput as (e: unknown) => void).call(tl, { target: { value: 60 } });
  // per-player stats grid: teams are the two fixture players; team 0 has
  // the alive unit 1 + the drawn ghost unit 2, team 1's unit 3 died at 50 s
  const counts = byId("unitCounts").innerHTML;
  assert.match(counts, /data-team="0" data-units="\d+"/, "team-0 grid row present with a live count");
  assert.ok(counts.indexOf('data-team="1"') !== -1, "every team gets a grid row, not just the first two players");
  const n0 = Number(/data-team="0" data-units="(\d+)"/.exec(counts)?.[1] ?? "0");
  assert.ok(n0 >= 2, `team-0 count includes alive+ghost units (got ${n0})`);
  assert.ok(teamConstantsAreGone(), "the old two-corner counters no longer exist");
  assert.match(String(byId("clock").textContent), /01:00 \/ 01:30/, "clock follows the seek (END = 90s)");

  // replay catalog: one select option per replay; switching loads the
  // next artifact (the fetch stub serves the same fixture bytes for any
  // URL, which is exactly what the switch path needs exercised)
  const pick = byId("replayPick");
  assert.ok((pick.children as unknown[]).length >= 2, "catalog select lists every replay");
  assert.ok(pick.onclick === null, "select uses onchange");
  pick.value = 1;
  (pick.onchange as () => void).call(pick);
  // the switch re-runs the full fetch -> streamed inflate -> installModel
  // chain; wait for it rather than racing a fixed 20 ms sleep
  await waitFor(() => /battle2\.zkr/.test(String(byId("chip").textContent)));
  assert.match(byId("chip").textContent, /battle2\.zkr/, "switching installs the second artifact");
  assert.match(String(byId("infoDur").textContent), /minutes/, "battle-result duration follows the loaded model");
});

test("page falls back to the synthetic preview when the artifact fetch fails", async () => {
  const { byId, state } = await runPage(null);
  assert.match(byId("chip").textContent, /synthetic/, "no-artifact run must show the synthetic preview");
  assert.ok(state.calls > 100, "synthetic preview must also draw");
  // synthetic units carry no .track; the wrecks guard must keep them rendering
  assert.ok(state.raf.length > 0, "loop alive after synthetic fallback");
});

test("healthv2 shading + wreck markers draw without breaking the loop", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zkr-page2-"));
  const artifact = buildArtifact(dir);
  const { byId, state } = await runPage(artifact);

  // switch to damage-shading mode: ring hidden, tinted icons/circles shaded
  byId("hpv1").checked = false;
  byId("hpv2").checked = true;
  const callsBefore = state.calls;
  const tl = byId("timeline");
  // 0 s (all alive) -> 30 s -> 55 s (past unit 3's tracked death at 50 s:
  // its wreck marker branch runs) -> 80 s (near game end)
  for (const t of [0, 30, 55, 80]) {
    tl.value = t;
    (tl.oninput as (e: unknown) => void).call(tl, { target: { value: t } });
  }
  assert.ok(state.calls > callsBefore, "draw continued in healthv2 mode");

  // wrecks toggle off must also render cleanly (no wreck dots, ghosts hidden)
  byId("wrecks").checked = false;
  for (const t of [60, 90]) {
    tl.value = t;
    (tl.oninput as (e: unknown) => void).call(tl, { target: { value: t } });
  }
  assert.ok(state.calls > callsBefore, "draw continued with wrecks hidden");

  // and v1+v2 both ticked (browsers allow it): v1 must win without throwing
  byId("hpv1").checked = true;
  byId("hpv2").checked = true;
  tl.value = 55;
  (tl.oninput as (e: unknown) => void).call(tl, { target: { value: 55 } });
  assert.ok(state.raf.length > 0, "rAF loop still alive");
});
