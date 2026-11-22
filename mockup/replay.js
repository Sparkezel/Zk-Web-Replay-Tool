/**
 * M3 — browser-side playback of a `.zkr` artifact.
 *
 * Mirrors the binary layouts written by src/daemon/pack.ts:
 *   POS  v1 (id "POS "): u32 numUnits, per unit: u32 unitID, u16 defID,
 *        u32 firstFrame, u16 sampleCount, samples: s16 dX, s16 dZ, u8 hp,
 *        u8 build
 *   EVNT v1 (id "EVNT"): u32 numRecords, per record: u8 kind, u32 frame,
 *        s32 unitID, s32 int1, s32 int2, s32 int3
 *   PROJ v1 (id "PROJ"): u32 numProjectiles, per: u32 proID, u32 weaponDefID,
 *        u8 class, u16 ownerTeam(+1), u32 startFrame, u16 sampleCount,
 *        u16 originX, u16 originY, u16 originZ, samples: s16 dX, s16 dZ,
 *        s16 absQY
 *   LINK v1 (id "LINK"): u32 numLinks, per: u32 djinnID, u32 lampID, u32 team,
 *        u32 openFrame, u32 closeFrame, u16 lampQX, u16 lampQZ
 *
 * Coordinates are quantized across map size to u16; dividing by 65535
 * normalizes them to [0, 1] for viewport-independent drawing. Time is frames
 * at 30 fps; the mockup converts to sim-seconds by dividing by 30.
 */
(function (global) {
  "use strict";

  const FPS = 30;
  const EVNT_KIND_NAME = ["spawn", "death", "finished", "transfer", "gameover"];
  const PROJ_CLASS_NAME = ["dropped", "beam", "artillery", "nuke", "missile", "interceptor"];
  const LINK_OPEN_SENTINEL = 0xffffffff;
  const STARTBOX_FADE_SEC = 30;
  /* engine bookkeeping units (ZK's terraform helper) are not real units —
     their hp is meaningless and they are never rendered or fed */
  const EXCLUDED_UNIT_DEFS = new Set(["terraunit"]);

  /* Allyteam palettes as multi-stop hsl walks. Even allyteams: bright
     green -> dark green -> cyan -> dark blue. Odd allyteams: bright red ->
     dark red -> orange -> dark brown -> light brown. Lightness zigzags so
     teammates stay visually separable (16 hard steps 3° apart were not); the
     family split keeps friend/foe readable at a glance. */
  const ALLY_STOPS = [
    [[130, 88, 62], [146, 76, 38], [163, 80, 56], [184, 76, 38], [206, 82, 52]],
    [[4, 88, 55], [12, 82, 38], [24, 88, 48], [36, 70, 32], [46, 66, 46], [28, 32, 62]],
  ];
  function rampColor(ally, f) {
    const stops = ALLY_STOPS[ally % 2];
    const pos = f * (stops.length - 1);
    const k = Math.min(Math.floor(pos), stops.length - 2);
    const t = pos - k;
    const c = [0, 1, 2].map((j) => Math.round(stops[k][j] + (stops[k + 1][j] - stops[k][j]) * t));
    return "hsl(" + c[0] + "," + c[1] + "%," + c[2] + "%)";
  }
  const ALLY16 = ALLY_STOPS.map((_, ally) => []);
  for (let ally = 0; ally < ALLY_STOPS.length; ally++) {
    for (let i = 0; i < 16; i++) ALLY16[ally].push(rampColor(ally, i / 15));
  }
  const TEAL16 = ALLY16[0], WARM16 = ALLY16[1];
  function teamColor(t, teamMeta) {
    if (t === null || t === undefined || t < 0) return "#9aa4aa";
    const m = teamMeta && teamMeta[t];
    if (m) return rampColor(m.ally, m.n > 1 ? m.idx / (m.n - 1) : 0);
    const ramp = (t % 2 === 0) ? TEAL16 : WARM16;
    return ramp[Math.floor(t / 2) % 16];
  }

  /* health ring colour: vibrant green at full health, orange at 60%,
     deep bright red at 0% (piecewise-linear hue so 60% lands exactly on
     orange instead of drifting through yellow-green) */
  function hpColor(hp) {
    if (hp === null || hp === undefined || !isFinite(hp)) return "#9aa4aa";
    let hue;
    if (hp >= 0.6) hue = 32 + (135 - 32) * ((hp - 0.6) / 0.4);
    else hue = 5 + (32 - 5) * Math.max(0, hp) / 0.6;
    const light = hp >= 0.6 ? 47 : 55 - 10 * hp / 0.6;
    return "hsl(" + Math.round(hue) + ",95%," + Math.round(light) + "%)";
  }

  /** hsl (0..360, 0..1, 0..1) -> [r, g, b] each 0..255 */
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = h / 60;
    const x = c * (1 - Math.abs(hp % 2 - 1));
    let r = 0, g = 0, b = 0;
    if (hp < 1) { r = c; g = x; }
    else if (hp < 2) { r = x; g = c; }
    else if (hp < 3) { g = c; b = x; }
    else if (hp < 4) { g = x; b = c; }
    else if (hp < 5) { r = x; b = c; }
    else { r = c; b = x; }
    const m = l - c / 2;
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }

  /** healthv2 damage shading: the unit's team colour IS its health bar —
      full hp shows the exact team colour, damage darkens the colour vector
      toward 75% (never below, so a nearly-dead unit still reads as its
      team's hue, just darker). hp is 0..1, quantized to 16 steps: the tint
      cache keys on the returned colour, and a shade per raw u8 hp level
      grew the icon cache to 12k offscreen canvases on a real sweep —
      17 reachable shades read identically and keep the cache bounded.
      Unparseable colours / absent hp pass through unchanged. */
  function damageShade(color, hp) {
    if (hp === null || hp === undefined || !isFinite(hp)) return color;
    const h = Math.round(Math.max(0, Math.min(1, hp)) * 16) / 16;
    const k = 0.75 + 0.25 * h;
    let rgb = null;
    const s = String(color);
    const m = /^hsl\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)%,\s*(\d+(?:\.\d+)?)%\)$/.exec(s);
    if (m) {
      rgb = hslToRgb(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100);
    } else {
      const hex = /^#([0-9a-f]{6})$/i.exec(s);
      if (hex) {
        rgb = [0, 1, 2].map((j) => parseInt(hex[1].slice(j * 2, j * 2 + 2), 16));
      }
    }
    if (!rgb) return color;
    return "rgb(" + rgb.map((v) => Math.round(v * k)).join(",") + ")";
  }

  /** Parse one leaf `{ ... }` body: `x1=..,z1=..` keys or positional
   *  {x1, z1, x2, z2}. Returns null unless all four corners parse. */
  function parseBoxBody(body) {
    const box = {};
    const keyRe = /([xyz]\d)\s*=\s*(-?[\d.]+(?:[eE][+-]?\d+)?)/g;
    let km, keyed = false;
    while ((km = keyRe.exec(body)) !== null) { box[km[1]] = parseFloat(km[2]); keyed = true; }
    if (!keyed) {
      const nums = (body.match(/-?[\d.]+(?:[eE][+-]?\d+)?/g) || []).map(Number).filter(Number.isFinite);
      if (nums.length >= 4) { box.x1 = nums[0]; box.z1 = nums[1]; box.x2 = nums[2]; box.z2 = nums[3]; }
    }
    if (box.x1 === undefined || box.z1 === undefined || box.x2 === undefined || box.z2 === undefined) return null;
    return box;
  }

  /**
   * Parse a Lua startbox blob (`return { ... }`, numbers may be scientific
   * notation). Handles both layouts seen in Zero-K data:
   *   per-allyteam:  `{ [0]={x1=..,z1=..,x2=..,z2=..}, [1]={..} }`
   *   bundled:       `{ [allyIdx]={ [0]={x1=..,z1=..,x2=..,z2=..}, .. } }`
   * Returns Map allyteamIndex -> [boxes] with corners normalized 0..1.
   */
  function parseStartboxesBlob(blob) {
    const out = new Map();
    const s = String(blob || "").replace(/^\s*return\s*/, "");
    let depth = 0, i = 0;
    const lastKey = [];
    while (i < s.length) {
      const c = s[i];
      if (c === "{") { depth++; i++; continue; }
      if (c === "}") { depth--; i++; continue; }
      const bm = /^\[\s*(\d+)\s*\]\s*=/.exec(s.slice(i));
      if (bm) { lastKey[depth] = parseInt(bm[1], 10); i += bm[0].length; continue; }
      const sm = /^[\s;]+/.exec(s.slice(i));
      if (sm) { i += sm[0].length; continue; }
      const close = s.indexOf("}", i);
      const open = s.indexOf("{", i);
      if (c !== "" && close > i && (open === -1 || open > close)) {
        const box = parseBoxBody(s.slice(i, close));
        if (box) {
          /* leaf depth differs by layout: bundled blobs have the allyteam key
             one level further out, so fall back to the inner key */
          const ally = (depth >= 2 && lastKey[depth - 2] !== undefined)
            ? lastKey[depth - 2]
            : lastKey[depth - 1];
          if (ally !== undefined && ally >= 0) {
            if (!out.has(ally)) out.set(ally, []);
            out.get(ally).push(box);
          }
        }
        i = close;
        continue;
      }
      i++;
    }
    return out;
  }

  /**
   * Startboxes per allyteam, from the ROST section: allyteams[].startboxes
   * blobs first, otherwise the bundled modoptions.startboxes blob. Returns
   * one array of {x1,z1,x2,z2} per allyteam (empty arrays when a side — or
   * the whole game — has no startboxes).
   */
  function parseStartboxes(allyteams, modoptions) {
    const perAlly = [];
    const blobs = (allyteams || []).map((at) => at && at.startboxes).filter(Boolean);
    if (blobs.length === 0 && modoptions && String(modoptions.startboxes || "").indexOf("{") !== -1) {
      const parsed = parseStartboxesBlob(modoptions.startboxes);
      if (parsed.size > 0) {
        const maxAlly = Math.max(...parsed.keys());
        for (let a = 0; a <= maxAlly; a++) perAlly.push(parsed.get(a) || []);
      }
      return perAlly;
    }
    for (const at of (allyteams || [])) {
      const parsed = parseStartboxesBlob((at && at.startboxes) || "");
      const all = [];
      for (const arr of parsed.values()) all.push(...arr);
      perAlly.push(all);
    }
    return perAlly;
  }

  /* unit-icon support: the page calls setUnitIconBase("icons/") once, then
     iconFor(iconType) returns a lazily-loaded Image (or null when no base is
     configured). Rendering falls back to a coloured circle until the PNG is
     loaded, and permanently when it fails. */
  let iconBase = "";
  const iconCache = new Map();
  function setUnitIconBase(url) {
    iconBase = String(url || "").replace(/\/?$/, "/");
  }
  function iconFor(iconType) {
    if (!iconBase || !iconType || typeof Image === "undefined") return null;
    if (!iconCache.has(iconType)) {
      const im = new Image();
      im.src = iconBase + encodeURIComponent(iconType) + ".png";
      iconCache.set(iconType, im);
    }
    return iconCache.get(iconType);
  }

  /* Recolour a unit icon into the owning player's colour, exactly like the
     game does: Spring icons are black linework on grey scale fills, and a
     plain multiply keeps the black lines black while the grey interiors take
     the team hue. Results are cached offscreen per (src, colour). */
  const tintCache = new Map();
  function tintIcon(img, color) {
    if (!img || !img.complete || !img.naturalWidth || !color) return null;
    const key = (img.src || "") + "|" + color;
    if (!tintCache.has(key)) {
      /* healthv2 feeds a shade per hp level, which would grow this cache
         unbounded (12k+ offscreen canvases measured on a full sweep);
         quantizing the shade below keeps live entries low, and the cap
         guarantees the ceiling even with many icons */
      if (tintCache.size > 600) tintCache.clear();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      g.globalCompositeOperation = "multiply";
      g.fillStyle = color;
      g.fillRect(0, 0, c.width, c.height);
      g.globalCompositeOperation = "destination-in";
      g.drawImage(img, 0, 0);
      tintCache.set(key, c);
    }
    return tintCache.get(key);
  }

  async function inflateSection(codec, payload) {
    if (codec === 0) return payload;
    if (codec !== 1) throw new Error("section codec " + codec + " is not supported in the browser; pack viewer artifacts with deflate");
    const ds = new DecompressionStream("deflate");
    const stream = new Blob([payload]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /* POS probe cadence: the snapshot widget samples every 6th engine frame
     (0.2 s). v1 sections carried no per-sample timing, so legacy artifacts
     decode with this fixed cadence — never one sample per frame, which
     compressed unit motion to a sixth of real time. */
  const POS_PROBE_EVERY = 6;

  function decodePos(dv, u8, version) {
    const p = { version, units: [], maxFrame: 0 };
    let o = 0;
    const numUnits = dv.getUint32(o, true); o += 4;
    for (let i = 0; i < numUnits; i++) {
      const unitID = dv.getUint32(o, true); o += 4;
      const defID = dv.getUint16(o, true); o += 2;
      const firstFrame = dv.getUint32(o, true); o += 4;
      const sampleCount = dv.getUint16(o, true); o += 2;
      const originX = dv.getUint16(o, true) / 65535; o += 2;
      const originZ = dv.getUint16(o, true) / 65535; o += 2;
      let x = originX, z = originZ;
      const samples = [];
      let frame = firstFrame;
      for (let k = 0; k < sampleCount; k++) {
        x += dv.getInt16(o, true) / 65535; o += 2;
        z += dv.getInt16(o, true) / 65535; o += 2;
        if (version >= 2) {
          frame += dv.getInt16(o, true); o += 2;
        } else {
          frame = firstFrame + k * POS_PROBE_EVERY;
        }
        const hp = u8[o] / 255; o += 1;
        const build = u8[o] / 255; o += 1;
        let ck = false, cf = undefined;
        // v3 adds the own-field bit; v1/v2 artifacts predate it — their bit1
        // is padding, so cf stays undefined and the viewer falls back to ck
        if (version >= 3) {
          const flags = u8[o]; o += 1;
          ck = (flags & 1) !== 0;
          cf = (flags & 2) !== 0;
        } else if (version === 2) {
          ck = (u8[o] & 1) !== 0; o += 1;
        }
        samples.push({ frame, x, z, hp, build, ck, cf });
      }
      p.units.push({ unitID, defID, firstFrame, samples });
      if (frame > p.maxFrame) p.maxFrame = frame;
    }
    return p;
  }

  function decodeEvnt(dv, u8) {
    const p = { records: [], maxFrame: 0 };
    let o = 0;
    const n = dv.getUint32(o, true); o += 4;
    for (let i = 0; i < n; i++) {
      const kind = dv.getUint8(o); o += 1;
      const frame = dv.getUint32(o, true); o += 4;
      const unitID = dv.getInt32(o, true); o += 4;
      const int1 = dv.getInt32(o, true); o += 4;
      const int2 = dv.getInt32(o, true); o += 4;
      const int3 = dv.getInt32(o, true); o += 4;
      p.records.push({ kind: EVNT_KIND_NAME[kind] ?? kind, frame, unitID, int1, int2, int3 });
      if (frame > p.maxFrame) p.maxFrame = frame;
    }
    return p;
  }

  function decodeProj(dv, u8, version) {
    const p = { paths: [], maxFrame: 0 };
    let o = 0;
    const n = dv.getUint32(o, true); o += 4;
    for (let i = 0; i < n; i++) {
      const proID = dv.getUint32(o, true); o += 4;
      const weaponDefID = dv.getUint32(o, true); o += 4;
      const cls = dv.getUint8(o); o += 1;
      const ownerTeam = dv.getUint16(o, true) - 1; o += 2;
      const startFrame = dv.getUint32(o, true); o += 4;
      const sampleCount = dv.getUint16(o, true); o += 2;
      const ox = dv.getUint16(o, true) / 65535; o += 2;
      const oy = dv.getUint16(o, true) / 65535; o += 2;
      const oz = dv.getUint16(o, true) / 65535; o += 2;
      const samples = [{ frame: startFrame, x: ox, z: oz, y: oy }];
      let x = ox, z = oz;
      let frame = startFrame;
      for (let k = 0; k < sampleCount; k++) {
        x += dv.getInt16(o, true) / 65535; o += 2;
        z += dv.getInt16(o, true) / 65535; o += 2;
        const y = dv.getInt16(o, true) / 65535; o += 2;
        if (version >= 2) {
          frame += dv.getInt16(o, true); o += 2;
        } else {
          frame = startFrame + (k + 1) * POS_PROBE_EVERY;
        }
        samples.push({ frame, x, z, y });
      }
      p.paths.push({ proID, weaponDefID, cls, team: ownerTeam, startFrame, samples });
      if (frame > p.maxFrame) p.maxFrame = frame;
    }
    return p;
  }

  function decodeLink(dv, u8) {
    const p = { links: [], maxFrame: 0 };
    let o = 0;
    const n = dv.getUint32(o, true); o += 4;
    for (let i = 0; i < n; i++) {
      const djinnID = dv.getUint32(o, true); o += 4;
      const lampID = dv.getUint32(o, true); o += 4;
      const team = dv.getUint32(o, true); o += 4;
      const openFrame = dv.getUint32(o, true); o += 4;
      const closeFrameRaw = dv.getUint32(o, true); o += 4;
      const closeFrame = closeFrameRaw === LINK_OPEN_SENTINEL ? -1 : closeFrameRaw;
      const lampQX = dv.getUint16(o, true) / 65535; o += 2;
      const lampQZ = dv.getUint16(o, true) / 65535; o += 2;
      p.links.push({ djinnID, lampID, team, openFrame, closeFrame, lampQX, lampQZ });
      if (closeFrame > p.maxFrame) p.maxFrame = closeFrame;
    }
    return p;
  }

  async function parse(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (u8.length < 4 || u8[0] !== 0x5a || u8[1] !== 0x4b || u8[2] !== 0x52) {
      throw new Error("not a .zkr artifact (bad magic)");
    }
    const sections = [];
    const raw = {};
    let o = 4;
    while (o + 16 <= u8.byteLength) {
      const id = String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]).trim();
      const version = new DataView(u8.buffer, u8.byteOffset + o + 4, 2).getUint16(0, true);
      const codec = u8[o + 6];
      const uncompressedSize = new DataView(u8.buffer, u8.byteOffset + o + 8, 4).getUint32(0, true);
      const compressedSize = new DataView(u8.buffer, u8.byteOffset + o + 12, 4).getUint32(0, true);
      o += 16;
      let data = u8.subarray(o, o + compressedSize);
      o += compressedSize;
      if (codec !== 0) data = await inflateSection(codec, data);
      if (data.byteOffset !== 0 || data.byteLength !== data.buffer.byteLength) data = data.slice();
      raw[id] = data;
      sections.push({ id, version, codec, uncompressedSize });
    }

    const json = (id) => {
      const r = raw[id];
      if (!r) return null;
      try { return JSON.parse(new TextDecoder().decode(r)); } catch (e) { return null; }
    };

    const versionOf = (id) => {
      const s = sections.find((x) => x.id === id);
      return s ? s.version : 1;
    };

    return {
      containerVersion: u8[3],
      sections,
      meta: json("META"),
      roster: json("ROST"),
      startboxesData: json("STBX"),
      unitDefs: json("UDEF"),
      weaponDefs: json("WDEF"),
      chat: json("CHAT"),
      macro: json("MACR"),
      eco: json("ECO"),
      psta: json("PSTA"),
      pos: raw["POS"] ? decodePos(new DataView(raw["POS"].buffer, raw["POS"].byteOffset, raw["POS"].byteLength), raw["POS"], versionOf("POS")) : null,
      evnt: raw["EVNT"] ? decodeEvnt(new DataView(raw["EVNT"].buffer, raw["EVNT"].byteOffset, raw["EVNT"].byteLength), raw["EVNT"]) : null,
      proj: raw["PROJ"] ? decodeProj(new DataView(raw["PROJ"].buffer, raw["PROJ"].byteOffset, raw["PROJ"].byteLength), raw["PROJ"], versionOf("PROJ")) : null,
      link: raw["LINK"] ? decodeLink(new DataView(raw["LINK"].buffer, raw["LINK"].byteOffset, raw["LINK"].byteLength), raw["LINK"]) : null,
    };
  }

  /**
   * Render model shared by the mockup page: unit tracks, projectile paths,
   * event feed, economy series and the victory state, all in sim-seconds
   * with [0..1] map-space coordinates.
   */
  function artifactToModel(artifact) {
    /* Two clocks meet in one artifact (counter-review verified this the hard
       way): resim sections (POS/EVNT/PROJ/LINK) run on ENGINE play frames —
       the engine does not simulate during the lobby/pick phase, so their
       frame 0 IS play start. Demo-derived sections (CHAT/ECO/PSTA/MACR) run
       on absolute demo frames, which include the pick phase (minutes of
       ready-up + commander picks in ZK teams games; MACR.startPlayingFrame
       is the epoch where play begins). Units keep the play clock; demo data
       is shifted by the anchor, so pre-game chat lands at tm <= 0 and is
       pre-shown instead of playing with the game. */
    const anchor = artifact.macro && artifact.macro.startPlayingFrame > 0
      ? artifact.macro.startPlayingFrame : 0;
    const toPlay = (f) => f / FPS;          // resim frame -> play second
    const toDemo = (f) => (f - anchor) / FPS; // demo frame -> play second
    const toSec = toPlay;                    // most sections here are resim/play-relative

    const teamByUnit = new Map();
    const defByUnit = new Map();
    const deathByUnit = new Map();
    let winner = null;
    let endFrame = 0;
    for (const r of (artifact.evnt ? artifact.evnt.records : [])) {
      if (r.kind === "spawn") { teamByUnit.set(r.unitID, r.int2); defByUnit.set(r.unitID, r.int1); }
      else if (r.kind === "death") { deathByUnit.set(r.unitID, r.frame); endFrame = Math.max(endFrame, r.frame); }
      else if (r.kind === "gameover") { winner = r.int1 >= 0 ? r.int1 : winner; endFrame = Math.max(endFrame, r.frame); }
    }
    if (defByUnit.size === 0) for (const r of (artifact.evnt ? artifact.evnt.records : [])) {
      if (r.kind === "spawn") defByUnit.set(r.unitID, r.int1);
    }

    /* ZK morphs destroy the old unit and spawn its target at the same spot
       in the same frame; EVNT carries only death, so morphs read as
       "destroyed" and would leave a wreck dot under the live morphed unit.
       Mark a death as a morph when a same-team unit spawns within 4 s and
       80 elmos of the dying unit's last tracked position. */
    const morphIntoByUnit = new Map();
    {
      const dims0 = artifact.meta && artifact.meta.map ? artifact.meta.map.dims : null;
      const mw = dims0 && dims0[0] > 0 ? dims0[0] : 16384;
      const mh = dims0 && dims0[1] > 0 ? dims0[1] : mw;
      const spawnsByTeam = {};
      for (const u of (artifact.pos ? artifact.pos.units : [])) {
        if (!u.samples.length) continue;
        const team = teamByUnit.has(u.unitID) ? teamByUnit.get(u.unitID) : 0;
        (spawnsByTeam[team] = spawnsByTeam[team] || []).push({
          unitID: u.unitID, t: toSec(u.firstFrame),
          x: u.samples[0].x, y: u.samples[0].z,
        });
      }
      for (const list of Object.values(spawnsByTeam)) list.sort((a, b) => a.t - b.t);
      for (const u of (artifact.pos ? artifact.pos.units : [])) {
        if (!u.samples.length || !deathByUnit.has(u.unitID)) continue;
        const team = teamByUnit.has(u.unitID) ? teamByUnit.get(u.unitID) : 0;
        const list = spawnsByTeam[team];
        if (!list) continue;
        const diedT = toSec(deathByUnit.get(u.unitID));
        const last = u.samples[u.samples.length - 1];
        for (const s of list) {
          if (s.unitID === u.unitID) continue;
          if (s.t < diedT - 4) continue;
          if (s.t > diedT + 4) break;
          const dx = (s.x - last.x) * mw, dz = (s.y - last.z) * mh;
          if (dx * dx + dz * dz <= 80 * 80) { morphIntoByUnit.set(u.unitID, s.unitID); break; }
        }
      }
    }

    const udef = new Map();
    for (const row of (artifact.unitDefs ? artifact.unitDefs.units : [])) {
      udef.set(row[0], {
        name: row[1], metalCost: row[2], health: row[3],
        canMove: row[4] === 1 ? true : row[4] === 0 ? false : undefined,
        iconType: row[5] || undefined,
        humanName: row[6] || undefined,
        // UDEF v2 column: area-cloak field radius in elmos (Iris, Onion);
        // ZK's Iris is the only cloaker whose radius never changed and whose
        // def predates the column — its known in-game value is the fallback
        cloakRadius: row.length > 7 && row[7] > 0 ? row[7]
          : row[1] === "cloakjammer" ? 350 : undefined,
      });
    }
    const wdef = new Map();
    for (const w of (artifact.weaponDefs ? artifact.weaponDefs.weapons : [])) wdef.set(w.id, w);

    /* team number -> player name(s), from the ROST section players;
       team -> allyteam mapping comes from the ROST teams list when present */
    const rosterPlayers = (artifact.roster && artifact.roster.players) || [];
    const teamNames = {};
    for (const p of rosterPlayers) {
      if (p.spectator || p.team === undefined || p.team < 0 || !p.name) continue;
      (teamNames[p.team] = teamNames[p.team] || []).push(p.name);
    }
    for (const tm of Object.keys(teamNames)) teamNames[tm] = teamNames[tm].join(" / ");
    const teamAllyteam = new Map();
    for (const t of ((artifact.roster && artifact.roster.teams) || [])) {
      if (t.num !== undefined && t.num >= 0) teamAllyteam.set(t.num, t.allyteam);
    }
    const defLabel = (unitID, fallback) => {
      if (unitID === undefined || unitID < 0) return null;
      const d = defByUnit.get(unitID);
      const info = d !== undefined ? udef.get(d) : null;
      if (!info) return fallback;
      return info.humanName || info.name || fallback;
    };
    const teamLabel = (team) => {
      const names = team !== undefined && team >= 0 ? teamNames[team] : null;
      return names || "Team " + (team + 1);
    };

    const feedData = [];
    for (const r of (artifact.evnt ? artifact.evnt.records : [])) {
      if (r.kind !== "death") continue;
      const deadDef = defByUnit.has(r.unitID) ? udef.get(defByUnit.get(r.unitID)) : null;
      if (deadDef && EXCLUDED_UNIT_DEFS.has((deadDef.name || "").toLowerCase())) continue;
      const unitName = defLabel(r.unitID, "Unit #" + r.unitID) || ("Unit #" + r.unitID);
      if (morphIntoByUnit.has(r.unitID)) {
        const intoName = defLabel(morphIntoByUnit.get(r.unitID), null) || "an upgraded unit";
        feedData.push({
          tm: toSec(r.frame), cls: "morph",
          txt: unitName + " morphed into " + intoName,
        });
        continue;
      }
      const killerName = defLabel(r.int1, r.int1 >= 0 ? "Unit #" + r.int1 : null);
      feedData.push({
        tm: toSec(r.frame), cls: "death",
        txt: unitName + " destroyed" +
             (killerName ? " — killed by " + killerName : "") +
             (r.int2 >= 0 ? " (" + teamLabel(r.int2) + ")" : ""),
      });
    }
    feedData.sort((a, b) => a.tm - b.tm);

    /* victory text: prefer the player names of the winning allyteam */
    let winnerLabel = null;
    if (winner !== null && winner !== undefined) {
      const winners = rosterPlayers.filter((p) => {
        if (p.spectator || p.team === undefined || p.team < 0) return false;
        return teamAllyteam.get(p.team) === winner;
      }).map((p) => p.name).filter(Boolean);
      winnerLabel = winners.length > 0 ? winners.join(" / ") : "Team " + (winner + 1);
    }

    /* team -> colour key: distinct ramp index per team within its own
       allyteam so same-side players share the hue family but never a colour */
    const teamsByAlly = {};
    for (const [num, ally] of teamAllyteam) {
      if (ally === undefined || ally < 0) continue;
      (teamsByAlly[ally] = teamsByAlly[ally] || []).push(num);
    }
    const teamMeta = {};
    for (const ally of Object.keys(teamsByAlly)) {
      const list = teamsByAlly[ally].sort((a, b) => a - b);
      list.forEach((tn, idx) => {
        teamMeta[tn] = { ally: Number(ally), idx, n: list.length };
      });
    }

    /* startboxes: engine-loaded polygons (STBX section, read from the map/game
       config via the start_boxes gadget's rules params) win over the startscript
       modoptions rects; per allyteam, list of polygons of [x, z] sums in 0..1 */
    const startPolys = [];
    const sbd = artifact.startboxesData;
    if (sbd && Array.isArray(sbd.boxes) && sbd.boxes.length > 0) {
      const boxById = new Map(sbd.boxes.map((b) => [b.id, b.polys || []]));
      const perAlly = new Map();
      for (const [ally, boxID] of (sbd.ally || [])) {
        const polys = boxById.get(boxID);
        if (polys) perAlly.set(ally, polys);
      }
      if (perAlly.size) {
        const maxAlly = Math.max(...perAlly.keys());
        for (let a = 0; a <= maxAlly; a++) startPolys.push(perAlly.get(a) || []);
      }
    } else {
      for (const rects of parseStartboxes(
        artifact.roster ? artifact.roster.allyteams : [],
        artifact.roster ? artifact.roster.modoptions : null)) {
        startPolys.push(rects.map((r) => [[r.x1, r.z1], [r.x2, r.z1], [r.x2, r.z2], [r.x1, r.z2]]));
      }
    }

    /* in-game chat: [frame, from, dest, text] rows; dest semantics per the
       engine's ChatMessage.h: 252 = allies, 253 = spectators, 254 = everyone,
       < playerNum = whisper; from 255 = autohost. SPRINGIE relay lines are
       autohost noise and are dropped. */
    const TO_ALLIES = 252, TO_SPECTATORS = 253, TO_EVERYONE = 254, SERVER_PLAYER = 255;
    const playerNameByNum = new Map();
    const playerAllyByNum = new Map();
    for (const p of rosterPlayers) {
      const m = /^(?:.*\/)?player(\d+)$/.exec(p.script || "");
      if (!m) continue;
      const n = Number(m[1]);
      if (p.name && !playerNameByNum.has(n)) playerNameByNum.set(n, p.name);
      if (!playerAllyByNum.has(n) && p.team !== undefined && p.team >= 0) {
        playerAllyByNum.set(n, teamAllyteam.get(p.team));
      }
    }
    const chatData = [];
    for (const row of (artifact.chat || [])) {
      const frame = row[0], from = row[1], dest = row[2], text = String(row[3] || "");
      if (text.startsWith("SPRINGIE:")) continue;
      const name = from === SERVER_PLAYER ? "autohost" : (playerNameByNum.get(from) || "Player " + from);
      let kind = "all", ally = null, to = null;
      if (dest === TO_ALLIES) { kind = "team"; ally = playerAllyByNum.get(from); }
      else if (dest === TO_SPECTATORS) kind = "spec";
      else if (dest === TO_EVERYONE) kind = "all";
      else if (from === SERVER_PLAYER) kind = "host";
      else if (typeof dest === "number" && dest >= 0 && dest < 32) {
        kind = "whisper";
        to = playerNameByNum.get(dest) || ("Player " + dest);
      }
      chatData.push({ tm: toDemo(frame), name, kind, ally, to, txt: text, pre: frame <= anchor });
    }
    chatData.sort((a, b) => a.tm - b.tm);

    const units = (artifact.pos ? artifact.pos.units : []).map((u) => {
      const info = udef.get(u.defID);
      let hpMax = 0;
      for (const s of u.samples) if (s.hp > hpMax) hpMax = s.hp;
      return {
        id: u.unitID, defID: u.defID,
        name: info ? (info.humanName || info.name) : undefined,
        def: info ? info.name : undefined,
        hpMax: hpMax > 0 ? hpMax : undefined,
        team: teamByUnit.has(u.unitID) ? teamByUnit.get(u.unitID) : 0,
        metalCost: info ? (info.metalCost ?? -1) : -1,
        kind: info && info.canMove === false ? "str" : undefined,
        icon: info ? (info.iconType || (info.name ? info.name.toLowerCase() : undefined)) : undefined,
        cloakRadius: info ? info.cloakRadius : undefined,
        born: toSec(u.firstFrame),
        died: deathByUnit.has(u.unitID) ? toSec(deathByUnit.get(u.unitID)) : -1,
        /* ZK morph victim: no wreck marker under the live morphed unit */
        morph: morphIntoByUnit.has(u.unitID),
        track: u.samples.map((s) => ({
          t: toSec(s.frame), x: s.x, y: s.z, hp: s.hp, bd: s.build,
          ck: s.ck,
          /* own area-cloak field active; undefined on artifacts packed
             before the field bit existed — the caller falls back to ck */
          cf: s.cf,
        })),
      };
    }).filter((u) => !u.def || !EXCLUDED_UNIT_DEFS.has(String(u.def).toLowerCase()));

    /* Spring recycles projectile IDs (u16 pools), so a byte-level "path" can
       be several unrelated flights concatenated by an older ingest. Real
       flights are probed every 6 frames — a >0.6 s hole in the sample
       stream means the first projectile is long dead: split there, so
       artifacts packed before the daemon-side fix render correctly too. */
    const PROJ_REUSE_GAP_FRAMES = 18;
    const projectiles = [];
    for (const p of (artifact.proj ? artifact.proj.paths : [])) {
      const mkPath = (seg) => ({
        proID: p.proID, cls: p.cls, clsName: PROJ_CLASS_NAME[p.cls] ?? "dropped",
        weaponDefID: p.weaponDefID, team: p.team,
        born: toSec(seg[0].frame),
        end: toSec(seg[seg.length - 1].frame),
        path: seg.map((s) => ({ t: toSec(s.frame), x: s.x, y: s.y, z: s.z })),
      });
      if (!p.samples.length) continue;
      let seg = [p.samples[0]];
      for (let i = 1; i < p.samples.length; i++) {
        const s = p.samples[i];
        if (s.frame - seg[seg.length - 1].frame > PROJ_REUSE_GAP_FRAMES) {
          projectiles.push(mkPath(seg));
          seg = [];
        }
        seg.push(s);
      }
      projectiles.push(mkPath(seg));
    }

    const links = (artifact.link ? artifact.link.links : []).map((l) => ({
      djinnID: l.djinnID, lampID: l.lampID, team: l.team,
      open: toSec(l.openFrame),
      close: l.closeFrame >= 0 ? toSec(l.closeFrame) : -1,
      lampX: l.lampQX, lampZ: l.lampQZ,
    }));

    const ecoPts = [];
    for (const t of (artifact.eco ? artifact.eco.teams : [])) {
      ecoPts.push({ team: t.team, pts: t.stats.map((s) => [toDemo(s.frame), s.metalProduced]) });
    }

    const posEnd = artifact.pos ? artifact.pos.maxFrame : 0;
    const projEnd = artifact.proj ? artifact.proj.maxFrame : 0;
    const linkEnd = artifact.link ? artifact.link.maxFrame : 0;
    // resim sections run on the play clock already - never anchor-shifted
    const endTime = toPlay(Math.max(endFrame, posEnd, projEnd, linkEnd));
    // META.gameTime is play seconds (demo header field counts from play
    // start, matching the resim's last sim frame / 30) - never shifted
    const metaEnd = artifact.meta && artifact.meta.gameTime ? artifact.meta.gameTime : 0;
    const dims = artifact.meta && artifact.meta.map ? artifact.meta.map.dims : null;

    return {
      fps: FPS,
      hasUnits: units.length > 0,
      units, projectiles, links, ecoPts, feedData,
      winner, winnerLabel,
      startPolys,
      teamNames, teamMeta, chatData,
      END: Math.max(endTime, metaEnd),
      mapName: artifact.meta ? artifact.meta.map.name : "",
      gameVersion: artifact.meta ? artifact.meta.gameVersion : "",
      engine: artifact.meta ? artifact.meta.engine : "",
      /* map elmo size ([w, h] from the widget via META.map.dims) — cloak-field
         circles scale against it; undefined on old artifacts */
      mapW: dims && dims[0] > 0 ? dims[0] : 0,
      mapH: dims && dims[1] > 0 ? dims[1] : (dims && dims[0] > 0 ? dims[0] : 0),
      pregameSec: anchor / FPS,
      unitNames: udef,
      weaponNames: wdef,
    };
  }

  /** Sample a unit track at time tm — coordinate + hp + build + cloak state
   *  interpolated between probes. Track points are {t, x, y} with y the map
   *  z-axis; hp/bd/ck step at the segment mid-point. */
  function trackAt(track, tm) {
    if (track.length === 0) return null;
    if (tm <= track[0].t) return track[0];
    const last = track[track.length - 1];
    if (tm >= last.t) return last;
    let lo = 0, hi = track.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (track[mid].t <= tm) lo = mid; else hi = mid;
    }
    const a = track[lo], b = track[hi];
    const f = (tm - a.t) / (b.t - a.t || 1);
    const near = f < 0.5 ? a : b;
    return {
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      hp: near.hp,
      bd: near.bd,
      ck: near.ck,
    };
  }

  /** Sample a projectile path at time tm (linear between probes). */
  function pathAt(path, tm) {
    if (tm <= path[0].t) return path[0];
    const last = path[path.length - 1];
    if (tm >= last.t) return last;
    let lo = 0, hi = path.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (path[mid].t <= tm) lo = mid; else hi = mid;
    }
    const a = path[lo], b = path[hi];
    const f = (tm - a.t) / (b.t - a.t || 1);
    return {
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      z: a.z + (b.z - a.z) * f,
    };
  }

  global.ZkrReplay = {
    parse, artifactToModel, trackAt, pathAt,
    parseStartboxes, parseStartboxesBlob, setUnitIconBase, iconFor, tintIcon,
    teamColor, hpColor, hslToRgb, damageShade, TEAL16, WARM16,
    EXCLUDED_UNIT_DEFS,
    FPS, PROJ_CLASS_NAME, EVNT_KIND_NAME, STARTBOX_FADE_SEC,
  };
})(typeof window !== "undefined" ? window : globalThis);
