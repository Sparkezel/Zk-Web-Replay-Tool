/**
 * Headless run of mockup/index.html's inline script over the real artifact:
 * stubs DOM/canvas/fetch, then drives the rAF loop (with Play toggled on) and
 * a full timeline sweep. Any viewer-side runtime error shows up here with a
 * stack — no browser needed.  node scripts/sim-viewer.mjs [artifactPath]
 */
import { readFileSync } from "node:fs";
import "node:child_process";

const artifact = process.argv[2] ?? "mockup/battle.zkr";

// ---------- DOM stubs ----------
function makeClassList() {
  const s = new Set();
  return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c) };
}
const elements = new Map();
function makeEl(id, kind = "div") {
  const el = {
    id, kind, checked: true, textContent: "", innerHTML: "", value: 0, max: 100,
    scrollTop: 0, disabled: false, className: "", classList: makeClassList(),
    children: [],
    width: 800, height: 600, clientWidth: 800, clientHeight: 460,
    naturalWidth: 0, naturalHeight: 0, complete: false,
    appendChild(c) { this.children.push(c); return c; },
    onclick: null, oninput: null,
    getContext() { return makeCx(); },
    querySelector() { return makeEl("q", "span"); },
    addEventListener() {},
  };
  return el;
}
let cxCalls = 0, cxErrors = [];
function makeCx() {
  const nul = () => {};
  const guard = (name) => (...args) => {
    cxCalls++;
    for (const a of args) {
      if (typeof a === "number" && !Number.isFinite(a)) {
        cxErrors.push(`canvas ${name} non-finite arg: ${args}`);
        throw new Error(`canvas ${name}() non-finite arg: ${args.join(",")}`);
      }
      // browsers throw IndexSizeError on negative arc radius
      if (name === "arc" && typeof args[2] === "number" && args[2] < 0) {
        cxErrors.push(`arc negative radius ${args[2]}`);
        throw new Error(`canvas arc() negative radius ${args[2]}`);
      }
      if (name === "drawImage") {
        const [, , w, h] = args;
        if ((w !== undefined && (!Number.isFinite(w) || w <= 0)) || (h !== undefined && (!Number.isFinite(h) || h <= 0))) {
          cxErrors.push(`drawImage bad size w=${w} h=${h}`);
          throw new Error(`canvas drawImage() bad size w=${w} h=${h}`);
        }
      }
    }
  };
  return new Proxy({ globalAlpha: 1, lineWidth: 1, setLineDash: nul, strokeStyle: "", fillStyle: "" }, {
    get(t, p) {
      if (p in t) return t[p];
      return guard(String(p));
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}

const byId = new Map();
globalThis.document = {
  getElementById(id) {
    if (!byId.has(id)) byId.set(id, makeEl(id));
    return byId.get(id);
  },
  querySelector() { return makeEl("q", "span"); },
  createElement(tag) { return makeEl("dyn-" + tag, tag); },
};

// window/globalThis script bits
const listens = [];
globalThis.window = globalThis;
globalThis.addEventListener = (ev, fn) => listens.push([ev, fn]);
class Image {
  constructor() { this.src = ""; this._handlers = {}; }
  set onload(f) { this._handlers.load = f; }
  get complete() { return false; }
  get naturalWidth() { return 0; }
  get naturalHeight() { return 0; }
}
globalThis.Image = Image;
globalThis.performance = { now: () => simTimeMs };
let simTimeMs = 0;
const rafQueue = [];
globalThis.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };

// fetch: serve the real bytes without HTTP (exact ArrayBuffer — Buffer.buffer
// may be Node's shared pool for small files). Missing files resolve as a
// soft 404 (same shape a browser gives) — page-side loaders must degrade,
// never throw: the draw loop is the thing under test here.
globalThis.fetch = (url) => {
  const p = String(url).startsWith("http") ? "mockup/" + String(url).split("/").pop() : String(url);
  let data;
  try {
    data = readFileSync(p === "battle.zkr" ? artifact : p);
  } catch (e) {
    return Promise.resolve({ ok: false, status: 404,
      text: () => Promise.resolve(""), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
  }
  const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(data.toString("utf8")),
    arrayBuffer: () => Promise.resolve(ab) });
};

// ---------- run the page script ----------
const html = readFileSync("mockup/index.html", "utf8");
const m = /<script>\s*([\s\S]*)<\/script>\s*<\/body>/m.exec(html);
if (!m) { console.error("could not extract inline script"); process.exit(1); }
const src = m[1];
await import("../mockup/replay.js");

// run the page's inline script in this scope with our stubs
try {
  // eslint-disable-next-line no-eval
  (0, eval)(src);
} catch (e) {
  console.error("PAGE SCRIPT THREW DURING LOAD:", e.stack ?? e);
  process.exit(2);
}

// wait for the async artifact load: deflate-decompressing the POS/PROJ
// sections of a real artifact takes a variable 0.2-1 s on a busy machine,
// so poll for readiness (globalThis.MODEL is null while loading) — a fixed
// 200 ms sleep reported "0 canvas calls" flakes on slow runs
let waitedMs = 0;
while (!globalThis.MODEL && waitedMs < 15000) {
  await new Promise((r) => setTimeout(r, 25));
  waitedMs += 25;
}
if (!globalThis.MODEL) {
  console.error("artifact did not load within 15 s — fetch/parse chain failed or hung");
  process.exit(6);
}
console.log("after load: typeof MODEL =",
  (globalThis.MODEL && typeof globalThis.MODEL.units === "object" && Array.isArray(globalThis.MODEL.units)) ? "model (ready)" : "loaded",
  "| typeof ZkrReplay =", typeof globalThis.ZkrReplay,
  "| rafQueue =", rafQueue.length,
  "| unresolved:", globalThis.__zkrSimSeen,
  "| waited:", waitedMs, "ms");
const byIdReal = globalThis.document.getElementById;

// drive: press play, run 600 frames of the animation loop
const playBtn = byIdReal("playBtn");
const timelineEl = byIdReal("timeline");
try {
  if (playBtn.onclick) playBtn.onclick();
  for (let i = 0; i < 600; i++) {
    simTimeMs += 16.67;
    const q = rafQueue.splice(0);
    for (const fn of q) fn(simTimeMs);
  }
  console.log("animation: 600 rAF frames OK");
} catch (e) {
  console.error("ANIMATION LOOP THREW:", e.stack ?? e);
  process.exit(3);
}
try {
  for (let t = 0; t <= 1520; t += 10) {
    timelineEl.value = t;
    if (timelineEl.oninput) timelineEl.oninput.call(timelineEl, { target: { value: t } });
  }
  console.log("seek: full timeline sweep OK");
} catch (e) {
  console.error("SEEK THREW:", e.stack ?? e);
  process.exit(4);
}
console.log("canvas calls:", cxCalls, "canvas guard errors:", cxErrors.length ? cxErrors.slice(0, 5) : "none");
console.log("simState:", JSON.stringify(byIdReal("simState").textContent));
console.log("chip:", JSON.stringify(byIdReal("chip").textContent));
// mid-game check: seek to t=600 and count what the page shows
try {
  timelineEl.value = 600;
  if (timelineEl.oninput) timelineEl.oninput.call(timelineEl, { target: { value: 600 } });
  const ucRows = String(byIdReal("unitCounts").innerHTML || "").match(/data-units="(\d+)"/g) || [];
  console.log("mid-game t=600s unit rows:", ucRows.length, ucRows.join(","), "| frame=", byIdReal("frameInfo").textContent, " clock:", byIdReal("clock").textContent,
    "| team table rows:", String(byIdReal("teamRows").innerHTML || "").match(/<tr/g)?.length ?? 0);
} catch (e) {
  console.error("MID-GAME SEEK THREW:", e.stack ?? e);
  process.exit(5);
}

// healthv2 sweep: exercise the damage-shade branch (damageShade on real team
// colours + the bounded tint cache) against the real artifact, past real
// deaths/wreck markers; then restore the v1 default
try {
  byIdReal("hpv1").checked = false;
  byIdReal("hpv2").checked = true;
  const before = cxCalls;
  for (let i = 0; i < 200; i++) {
    simTimeMs += 16.67;
    const q = rafQueue.splice(0);
    for (const fn of q) fn(simTimeMs);
  }
  for (let t = 0; t <= 1520; t += 40) {
    timelineEl.value = t;
    if (timelineEl.oninput) timelineEl.oninput.call(timelineEl, { target: { value: t } });
  }
  console.log("healthv2 sweep OK: +", cxCalls - before, "canvas calls, guard errors:", cxErrors.length ? cxErrors.slice(0, 5) : "none");
} catch (e) {
  console.error("HEALTHV2 SWEEP THREW:", e.stack ?? e);
  process.exit(7);
} finally {
  byIdReal("hpv1").checked = true;
  byIdReal("hpv2").checked = false;
}
