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
// may be Node's shared pool for small files)
globalThis.fetch = (url) => {
  const p = String(url).startsWith("http") ? "mockup/" + String(url).split("/").pop() : String(url);
  const data = readFileSync(p === "battle.zkr" ? artifact : p);
  const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(ab) });
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

// wait for the async artifact load to finish
for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10));
console.log("after load: typeof MODEL =", typeof globalThis.MODEL,
  "| typeof ZkrReplay =", typeof globalThis.ZkrReplay,
  "| rafQueue =", rafQueue.length,
  "| unresolved:", globalThis.__zkrSimSeen);
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
  console.log("mid-game t=600s counters: cnt1=", byIdReal("cnt1").textContent, " cnt2=", byIdReal("cnt2").textContent, " frame=", byIdReal("frameInfo").textContent, " clock:", byIdReal("clock").textContent);
} catch (e) {
  console.error("MID-GAME SEEK THREW:", e.stack ?? e);
  process.exit(5);
}
