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
  const EVNT_KIND_NAME = ["spawn", "death", "finished", "transfer", "gameover", "wreck", "unwreck"];
  const PROJ_CLASS_NAME = ["dropped", "beam", "artillery", "nuke", "missile", "interceptor"];
  const LINK_OPEN_SENTINEL = 0xffffffff;
  const STARTBOX_FADE_SEC = 30;
  /* morph pairing: ZK's morph gadget spawns the target in the very frame
     the victim dies (measured 0-frame delta on real comms); 0.4 s admits
     probe quantization while a same-spot REBUILD (minutes later, or a
     nanoframe at bd<1) no longer reads as a morph */
  const MORPH_PAIR_WINDOW_SEC = 0.4;
  /* engine bookkeeping units (ZK's terraform helper) are not real units —
     their hp is meaningless and they are never rendered or fed */
  const EXCLUDED_UNIT_DEFS = new Set(["terraunit"]);

  /** defs that must never reach the model, feed or pairing: the terraform
   *  helper plus ZK's own invisible proxy units (fakeunit_los is the Scan
   *  Sweep LoS provider spawned at y=10000 — it also poisons the morph
   *  pairing, because a dying plane within 80 elmos of the spawn point
   *  reads as "morphed into LOS Provider") */
  function isExcludedDef(defName) {
    const n = String(defName || "").toLowerCase();
    return EXCLUDED_UNIT_DEFS.has(n) || n.indexOf("fakeunit") === 0;
  }

  /** Coarse unit-value class for the per-player stats grid, from the UDEF
   *  iconType (Spring icons are reliable well past per-fallback heuristics):
   *  econ = production & storage (energy icons, mex, pylon), other = factories, pads,
   *  builders, radar, jammers and commanders, everything else = combat. */
  function unitValueClass(defName, iconType) {
    const ic = String(iconType || defName || "").toLowerCase();
    const nm = String(defName || "").toLowerCase();
    if (ic.indexOf("energy") === 0 || ic === "mex" || ic === "storage" ||
        ic === "pylon" || nm.indexOf("energy") === 0) return "econ";
    if (ic.indexOf("fac") === 0 || ic.indexOf("pad") === 0 || ic === "builder" ||
        ic === "staticbuilder" || ic === "radar" || ic === "advradar" ||
        ic.indexOf("jammer") !== -1 || ic.indexOf("commander") === 0 ||
        ic === "none" || /factory|gantry|hub/.test(nm)) return "other";
    return "combat";
  }

  /* Dynamic commander levels: the generated level defs embed ZK's comm_level
     as the digit in dyn<chassis><level>_<modules>; the chassis base defs
     end in "_base" and are level 0 (the game displays level+1). ZK never
     updates the generated def's metalCost, so a leveled comm still records
     its ~1100 base cost in UDEF — its investment lives in the level morph
     costs (dynamic_comm_defs.lua morphCosts) plus per-module costs; the
     module share is not recoverable from the artifact and stays uncounted */
  const COMM_MORPH_BASE_COSTS = [50, 100, 150, 200, 250];
  function commLevelOfDef(defName) {
    if (!defName) return undefined;
    if (/_base$/.test(defName)) return 0;
    const m = /^dyn[a-z]+(\d+)_/.exec(defName);
    return m ? Number(m[1]) : undefined;
  }
  function commValueOfDef(defName, baseCost) {
    const lvl = commLevelOfDef(defName);
    if (lvl === undefined || baseCost === undefined || baseCost < 0) return undefined;
    let add = 0;
    for (let i = 0; i < lvl && i < COMM_MORPH_BASE_COSTS.length; i++) add += COMM_MORPH_BASE_COSTS[i];
    return baseCost + add;
  }

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
      toward 50% (never below, so a nearly-dead unit still reads as its
      team's hue, just much darker). hp is 0..1, quantized to 16 steps: the
      tint cache keys on the returned colour, and a shade per raw u8 hp level
      grew the icon cache to 12k offscreen canvases on a real sweep —
      17 reachable shades read identically and keep the cache bounded.
      Unparseable colours / absent hp pass through unchanged. */
  function damageShade(color, hp) {
    if (hp === null || hp === undefined || !isFinite(hp)) return color;
    const h = Math.round(Math.max(0, Math.min(1, hp)) * 16) / 16;
    const k = 0.5 + 0.5 * h;
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

  /** shield charge colour: ZK's own shield rendering lerps between
      shieldGoodColor (0.1 0.1 1 → rgb 26,26,255) at full charge and
      shieldBadColor (1 0.1 0.1 → rgb 255,26,26) when drained, smoothly.
      Charge is 0..1 (deep red) .. (deep blue). */
  function shieldColor(charge, alpha) {
    const c = Math.max(0, Math.min(1, charge));
    const r = Math.round(255 + (26 - 255) * c);
    const g = 26;
    const b = Math.round(26 + (255 - 26) * c);
    return alpha === undefined
      ? "rgb(" + r + "," + g + "," + b + ")"
      : "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
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
    /* ZK's own icontypes.lua resolves iconType "cruisemissilesmall" (the
       five stockpiled silo missiles: Eos/Shockley/Zeno/Quake/Inferno) to
       icons/cruisemissile.dds - the silo missiles keep their radar icon
       until they fly (in flight they become the coloured warhead dots) */
    if (iconType === "cruisemissilesmall") iconType = "cruisemissile";
    if (!iconBase || !iconType || typeof Image === "undefined") return null;
    if (!iconCache.has(iconType)) {
      const im = new Image();
      /* a 404 (icon file not synced from game data) settles with
         complete=true and naturalWidth=0 — the page detects that and
         names the backup-circle units in the feed */
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
  const TINT_CACHE_MAX = 1500;
  function tintIcon(img, color) {
    if (!img || !img.complete || !img.naturalWidth || !color) return null;
    const key = (img.src || "") + "|" + color;
    if (tintCache.has(key)) {
      /* LRU touch: re-insert as newest so a full hpv2 sweep evicts the
         genuinely-cold canvases instead of mass-clearing (the old clear-all
         at >600 entries caused periodic re-tint storms = the Otago stutter) */
      const c = tintCache.get(key);
      tintCache.delete(key);
      tintCache.set(key, c);
      return c;
    }
    /* healthv2 feeds a shade per hp level, which would grow this cache
       unbounded (12k+ offscreen canvases measured on a full sweep);
       quantizing the shade (damageShade) keeps live entries low, and the
       LRU cap guarantees the ceiling even with many icons */
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
    /* evict oldest (first inserted) — a bounded amortized cost per frame
       instead of the old nuke-everything */
    if (tintCache.size > TINT_CACHE_MAX) {
      tintCache.delete(tintCache.keys().next().value);
    }
    return c;
  }

  /** The nuke / antinuke-interceptor in-flight markers: the icon drawn as
   *  a slight team-coloured BORDER only — no inner filling (a fully tinted
   *  icon reads as a solid blob gliding along the trail). The tinted icon
   *  is erased in the interior with a shrunken copy of itself
   *  (destination-out), leaving its own silhouette as the border ring.
   *  Shares tintIcon's LRU cache. */
  function outlineIcon(img, color) {
    if (!img || !img.complete || !img.naturalWidth || !color) return null;
    const key = (img.src || "") + "|" + color + "|out";
    if (tintCache.has(key)) {
      const c = tintCache.get(key);
      tintCache.delete(key);
      tintCache.set(key, c);
      return c;
    }
    const tinted = tintIcon(img, color);
    if (!tinted) return null;
    const c = document.createElement("canvas");
    c.width = tinted.width; c.height = tinted.height;
    const g = c.getContext("2d");
    g.drawImage(tinted, 0, 0);
    g.globalCompositeOperation = "destination-out";
    const s = 0.66; /* erase the middle 66% -> ~17% silhouette border/side */
    g.drawImage(tinted, c.width * (1 - s) / 2, c.height * (1 - s) / 2, c.width * s, c.height * s);
    tintCache.set(key, c);
    if (tintCache.size > TINT_CACHE_MAX) {
      tintCache.delete(tintCache.keys().next().value);
    }
    return c;
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
        let ck = false, cf = undefined, cs = undefined, sh = undefined;
        // v3 adds the own-field/cloak-stall bits and a shield charge byte;
        // v1/v2 artifacts predate them — bit1/bit2 are padding there, so cf/cs
        // stay undefined and the viewer falls back to ck for the field state
        if (version >= 3) {
          const flags = u8[o]; o += 1;
          ck = (flags & 1) !== 0;
          cf = (flags & 2) !== 0;
          cs = (flags & 4) !== 0;
          const sv = u8[o]; o += 1;
          if (sv !== 255) sh = sv / 254;
        } else if (version === 2) {
          ck = (u8[o] & 1) !== 0; o += 1;
        }
        samples.push({ frame, x, z, hp, build, ck, cf, cs, sh });
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

  /** PTGT v1 — commanded targets of sent strategic missiles:
   * u32 count, per row: u32 proID, u32 frame, u16 x, u16 z (map fractions
   * 0..1, elmos quantized across the map like PROJ). One row per
   * (pid, target); the model picks the LATEST row at-or-before each
   * flight's end, so proID recycling never crosses targets over. */
  function decodePtgt(dv) {
    const rows = [];
    let o = 0;
    const n = dv.getUint32(o, true); o += 4;
    for (let i = 0; i < n; i++) {
      const proID = dv.getUint32(o, true); o += 4;
      const frame = dv.getUint32(o, true); o += 4;
      const x = dv.getUint16(o, true) / 65535; o += 2;
      const z = dv.getUint16(o, true) / 65535; o += 2;
      rows.push({ proID, frame, x, z });
    }
    return rows;
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

  /** sparse per-unit state transitions (slow/EMP/disarm/fire):
   *  [frame u32][unitID u32][bits u8][slowQ u8]; bits 1=fire, 2=disarm,
   *  4=EMP-stunned, slowQ = slowFrac * 16. Only transitions are recorded —
   *  a unit with no records was never affected. */
  function decodeStates(dv, u8) {
    const p = { records: [] };
    if (u8.length < 4) return p;
    let o = 0;
    const n = dv.getUint32(o, true); o += 4;
    for (let i = 0; i < n; i++) {
      const frame = dv.getUint32(o, true); o += 4;
      const unitID = dv.getUint32(o, true); o += 4;
      const bits = dv.getUint8(o); o += 1;
      const slowQ = dv.getUint8(o); o += 1;
      p.records.push({ frame, unitID, bits, slow: slowQ / 16 });
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
      metalSpots: json("MESP"),
      unitDefs: json("UDEF"),
      weaponDefs: json("WDEF"),
      chat: json("CHAT"),
      macro: json("MACR"),
      eco: json("ECO"),
      psta: json("PSTA"),
      pos: raw["POS"] ? decodePos(new DataView(raw["POS"].buffer, raw["POS"].byteOffset, raw["POS"].byteLength), raw["POS"], versionOf("POS")) : null,
      evnt: raw["EVNT"] ? decodeEvnt(new DataView(raw["EVNT"].buffer, raw["EVNT"].byteOffset, raw["EVNT"].byteLength), raw["EVNT"]) : null,
      proj: raw["PROJ"] ? decodeProj(new DataView(raw["PROJ"].buffer, raw["PROJ"].byteOffset, raw["PROJ"].byteLength), raw["PROJ"], versionOf("PROJ")) : null,
      ptgt: raw["PTGT"] ? decodePtgt(new DataView(raw["PTGT"].buffer, raw["PTGT"].byteOffset, raw["PTGT"].byteLength)) : null,
      link: raw["LINK"] ? decodeLink(new DataView(raw["LINK"].buffer, raw["LINK"].byteOffset, raw["LINK"].byteLength), raw["LINK"]) : null,
      states: raw["STAT"] ? decodeStates(new DataView(raw["STAT"].buffer, raw["STAT"].byteOffset, raw["STAT"].byteLength), raw["STAT"]) : null,
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
    const killerByUnit = new Map();
    let winner = null;
    let endFrame = 0;
    let gameOverFrame = -1;
    for (const r of (artifact.evnt ? artifact.evnt.records : [])) {
      if (r.kind === "spawn") { teamByUnit.set(r.unitID, r.int2); defByUnit.set(r.unitID, r.int1); }
      else if (r.kind === "death") {
        deathByUnit.set(r.unitID, r.frame);
        killerByUnit.set(r.unitID, r.int1);
        endFrame = Math.max(endFrame, r.frame);
      }
      else if (r.kind === "gameover") {
        winner = r.int1 >= 0 ? r.int1 : winner;
        endFrame = Math.max(endFrame, r.frame);
        gameOverFrame = Math.max(gameOverFrame, r.frame);
      }
    }
    if (defByUnit.size === 0) for (const r of (artifact.evnt ? artifact.evnt.records : [])) {
      if (r.kind === "spawn") defByUnit.set(r.unitID, r.int1);
    }
    /* tracks with no recorded spawn event — real units always get one, so a
       spawn-less track is an engine-side helper (the terraform-era defID-0
       crutches seen on the stress artifact); the units table drops them */
    const spawnedUnitIds = new Set();
    for (const r of (artifact.evnt ? artifact.evnt.records : [])) {
      if (r.kind === "spawn") spawnedUnitIds.add(r.unitID);
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
        // UDEF v3 columns: Shield-type weapon radius (>= 200 elmos counts as
        // an area shield: aspis/aegis/funnelweb/comm areashield; smaller
        // personal shields — thug/felon/comm personal module — feed the
        // fallback charge bar only) and its max charge (shieldPower)
        shieldRadius: row.length > 8 && row[8] > 0 ? row[8] : undefined,
        shieldPower: row.length > 9 && row[9] > 0 ? row[9] : undefined,
        // UDEF v4 column: anti-nuke interception radius (ZK nuke_coverage;
        // ZK's own coverage widget reads the same value)
        antiNukeCoverage: row.length > 10 && row[10] > 0 ? row[10] : undefined,
      });
    }
    const defNameOfUnit = (unitID) => {
      const d = defByUnit.get(unitID);
      const info = d !== undefined ? udef.get(d) : null;
      return info ? info.name : null;
    };

    /* ZK morphs destroy the old unit and spawn its target at the same spot
       in the same frame; EVNT carries only death, so morphs read as
       "destroyed" and would leave a wreck dot under the live morphed unit.
       A REAL morph victim is a complete unit (bd = 1) which destroys ITSELF
       — the engine records no killer — and whose target spawns complete
       within 0.4 s within 80 elmos. A nanoframe death is a kill or the
       builder cancelling the frame; a same-spot rebuild starts at bd < 1;
       a death with an enemy killer attributed is a kill — none of them
       pair as a morph. Excluded (terra/fakeunit) defs never enter either
       side of the pairing. Cavem: unit_morph copies buildProgress to the
       target (an unfinished unit CAN morph), so a shift-queued nanoframe
       morph reads "cancelled" — not present in real data, accepted. */
    const morphIntoByUnit = new Map();
    const parentOfUnit = new Map();
    const lastBuildByUnit = new Map();
    {
      const dims0 = artifact.meta && artifact.meta.map ? artifact.meta.map.dims : null;
      const mw = dims0 && dims0[0] > 0 ? dims0[0] : 16384;
      const mh = dims0 && dims0[1] > 0 ? dims0[1] : mw;
      const spawnsByTeam = {};
      for (const u of (artifact.pos ? artifact.pos.units : [])) {
        if (!u.samples.length || isExcludedDef(defNameOfUnit(u.unitID))) continue;
        lastBuildByUnit.set(u.unitID, u.samples[u.samples.length - 1].build);
        const team = teamByUnit.has(u.unitID) ? teamByUnit.get(u.unitID) : 0;
        (spawnsByTeam[team] = spawnsByTeam[team] || []).push({
          unitID: u.unitID, t: toSec(u.firstFrame),
          x: u.samples[0].x, y: u.samples[0].z,
          b0: u.samples[0].build,
        });
      }
      for (const list of Object.values(spawnsByTeam)) list.sort((a, b) => a.t - b.t);
      for (const u of (artifact.pos ? artifact.pos.units : [])) {
        if (!u.samples.length || !deathByUnit.has(u.unitID)) continue;
        if (isExcludedDef(defNameOfUnit(u.unitID))) continue;
        if ((lastBuildByUnit.get(u.unitID) ?? 1) < 0.99) continue;
        /* a morph victim destroys itself: a real kill (killer >= 0) is a
           kill even when a same-spot spawn coincides within the window */
        if ((killerByUnit.get(u.unitID) ?? -1) >= 0) continue;
        const team = teamByUnit.has(u.unitID) ? teamByUnit.get(u.unitID) : 0;
        const list = spawnsByTeam[team];
        if (!list) continue;
        const diedT = toSec(deathByUnit.get(u.unitID));
        const last = u.samples[u.samples.length - 1];
        for (const s of list) {
          if (s.unitID === u.unitID) continue;
          if (s.t < diedT - MORPH_PAIR_WINDOW_SEC) continue;
          if (s.t > diedT + MORPH_PAIR_WINDOW_SEC) break;
          if (s.b0 < 0.99) continue;
          const dx = (s.x - last.x) * mw, dz = (s.y - last.z) * mh;
          if (dx * dx + dz * dz <= 80 * 80) {
            morphIntoByUnit.set(u.unitID, s.unitID);
            parentOfUnit.set(s.unitID, u.unitID);
            break;
          }
        }
      }
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

    /* commander chassis label: ZK names a comm after its base chassis def
       (dyntrainer/cX _base humanName, e.g. "Guardian"/"Slim"); the level
       defs (dynXX1_..) are generated without the profile name, so the
       chassis label is recovered by walking the morph chain back to its
       _base root */
    const chassisOfUnit = (unitID) => {
      let cur = unitID, guard = 0;
      while (cur !== undefined && guard++ < 32) {
        const defID = defByUnit.get(cur);
        const info = defID !== undefined ? udef.get(defID) : null;
        /* profiles come from player-typed names ("Commander " has a
           trailing space) — trim so the feed line has no dangling gap */
        if (info && /_base$/.test(info.name || "") && info.humanName) {
          return info.humanName.replace(/\s+$/, "") || null;
        }
        cur = parentOfUnit.get(cur);
      }
      return null;
    };
    const feedData = [];
    /* ---- stockpiled silo missiles: launched vs killed-in-silo ----
       A launched missile stops being a map unit: the engine moves it to
       the staging corner at the map's right edge (measured on The Hole:
       fraction 1,0) where it sits until a later sweep destroys it, long
       after impact. Death TIME cannot tell launched from killed — all
       150 of The Hole's missiles died in the post-gameover sweep, their
       impacts notwithstanding. The only in-data launch sign is a staging
       sample (x at the extreme edge, z at either extreme); the missile
       stockpiles at its silo deep inside the map before that. */
    const MISSILE_UNIT_DEFS = new Set(["tacnuke", "empmissile", "missileslow", "seismic", "napalmmissile"]);
    const launchTmByUnit = new Map();
    for (const uu of (artifact.pos ? artifact.pos.units : [])) {
      const info = udef.get(uu.defID);
      if (!info || !MISSILE_UNIT_DEFS.has(info.name)) continue;
      for (const s of uu.samples) {
        if (s.x > 0.95 && (s.z < 0.05 || s.z > 0.95)) {
          launchTmByUnit.set(uu.unitID, toSec(s.frame));
          break;
        }
      }
    }
    for (const r of (artifact.evnt ? artifact.evnt.records : [])) {
      if (r.kind !== "death") continue;
      const deadDef = defByUnit.has(r.unitID) ? udef.get(defByUnit.get(r.unitID)) : null;
      if (isExcludedDef(deadDef && deadDef.name)) continue;
      const unitName = defLabel(r.unitID, "Unit #" + r.unitID) || ("Unit #" + r.unitID);
      if (morphIntoByUnit.has(r.unitID)) {
        const childID = morphIntoByUnit.get(r.unitID);
        const childInfo = (() => {
          const d = defByUnit.get(childID);
          return d !== undefined ? udef.get(d) : null;
        })();
        /* ZK's own context menu shows commander "Level" as comm_level + 1
           (gui_contextmenu.lua: comm_level+1), and the level defs embed
           comm_level in their name (dynXX<level>_..) — so a base comm
           (level 0) morphing into dynXX1 reads "morphed to level 2",
           matching the in-game "Slim lvl:2" naming */
        const lvl = childInfo ? /^dyn[a-z]+(\d+)_/.exec(childInfo.name || "") : null;
        if (lvl) {
          const chassis = chassisOfUnit(r.unitID) || unitName;
          feedData.push({
            tm: toSec(r.frame), cls: "morph",
            txt: chassis + " morphed to level " + (Number(lvl[1]) + 1),
          });
        } else {
          const intoName = defLabel(childID, null) || "an upgraded unit";
          feedData.push({
            tm: toSec(r.frame), cls: "morph",
            txt: unitName + " morphed into " + intoName,
          });
        }
        continue;
      }
      /* stockpiled silo missile: a LAUNCHED one's story is told by its
         warhead flight (launch news + strike circle + blast) — its
         later engine-side destroy leaves no line. A missile that died
         never having staged was killed in (or swept out of) its silo,
         which is a different story and reads as such */
      if (deadDef && MISSILE_UNIT_DEFS.has(deadDef.name)) {
        if (launchTmByUnit.has(r.unitID)) continue;
        const siloKiller = defLabel(r.int1, r.int1 >= 0 ? "Unit #" + r.int1 : null);
        feedData.push({
          tm: toSec(r.frame), cls: "death",
          txt: unitName + " was destroyed before launching" +
               (siloKiller ? " — killed by " + siloKiller : ""),
        });
        continue;
      }
      /* unfinished unit dying before gameover with no killer = the builder
         cancelled the frame (enemy kills keep their killer). After the
         gameover frame the engine sweeps the field with killer-less
         destroys — those are defeat cleanup, NOT cancels, and read
         as plain destroyed */
      if ((lastBuildByUnit.get(r.unitID) ?? 1) < 0.99 && r.int1 < 0 &&
          (gameOverFrame < 0 || r.frame <= gameOverFrame)) {
        feedData.push({
          tm: toSec(r.frame), cls: "cancelled",
          txt: unitName + " was cancelled",
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

    /* per-player roster rows for the Teams table: name, elo, level, clan
       (all live in the demo startscript) plus the command count the engine
       reports per playerNum in the PSTAT section — the old table was
       hardcoded mock markup, which is why some players showed "—" */
    const cmdsByPlayerNum = new Map();
    for (const ps of (artifact.psta ?? [])) {
      if (ps && ps.index !== undefined && ps.numCommands !== undefined) {
        cmdsByPlayerNum.set(ps.index, ps.numCommands);
      }
    }
    const players = [];
    for (const p of rosterPlayers) {
      if (p.spectator || p.team === undefined || p.team < 0 || !p.name) continue;
      const nm = /^(?:.*\/)?player(\d+)$/.exec(p.script || "");
      players.push({
        team: p.team,
        name: p.name,
        elo: p.elo,
        level: p.level,
        clan: p.clan || undefined,
        country: p.countrycode || p.country || undefined,
        ally: teamAllyteam.get(p.team),
        cmds: nm ? cmdsByPlayerNum.get(Number(nm[1])) : undefined,
      });
    }
    players.sort((a, b) => (a.ally ?? 99) - (b.ally ?? 99) || a.team - b.team);

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
      chatData.push({ tm: toDemo(frame), name, kind, ally, to, txt: text, pre: frame <= anchor, from });
    }
    chatData.sort((a, b) => a.tm - b.tm);

    /* Autohost relay votes: the poll state lives in the RELAYED chat, with
       every change announced as a "Poll: <subject>? [!y=Y/T, !n=N/T]" line
       and "[END:SUCCESS/FAILED]" at resolution; players cast with
       "!vote 1" (yes) / "!vote 2" (no). Parsed here from the raw rows, so
       no extra recording exists or is needed; one poll runs at a time, and
       a vote only counts for the poll that was active when it was cast. */
    const votes = [];
    {
      let active = null;
      for (const row of (artifact.chat || [])) {
        const text = String(row[3] || "");
        const tm = toDemo(row[0]);
        const pm = /^Poll: (.*?)(?: ?\[(.+)\])$/.exec(text);
        if (pm) {
          const subject = pm[1].replace(/\?+$/, "").trim();
          const inner = pm[2];
          const end = /^END:(SUCCESS|FAILED)/.exec(inner);
          if (end) {
            if (active && active.subject === subject) {
              active.endTm = tm;
              active.success = end[1] === "SUCCESS";
              active = null;
            }
            continue;
          }
          const y = /!y=(\d+)\/(\d+)/.exec(inner);
          const n = /!n=(\d+)\/(\d+)/.exec(inner);
          if (active === null || active.subject !== subject) {
            /* a state line for a NEW subject supersedes any poll still
               open: autohost runs one poll at a time, so an orphaned
               endTm:null would pin its card forever — resolve it here
               instead (success stays unknown) */
            if (active) { active.endTm = tm; active.success = undefined; }
            active = { subject, yes: 0, no: 0, needed: 1, startTm: tm, endTm: null, success: undefined, voters: [] };
            votes.push(active);
          }
          if (y) { active.yes = Number(y[1]); active.needed = Number(y[2]); }
          if (n) { active.no = Number(n[1]); }
          continue;
        }
        const vm = /^!vote\s+([12])$/.exec(text);
        if (vm && active) {
          active.voters.push({
            tm, from: row[1],
            name: playerNameByNum.get(row[1]) || ("Player " + row[1]),
            yes: vm[1] === "1",
          });
        }
      }
    }

    /* sparse per-unit state transitions (slow / EMP / disarm / on-fire);
     * grouped per unit and pre-converted to seconds — the arrays are tiny
     * and already in frame order, a linear scan per drawn unit is free */
    const statesByUnit = new Map();
    for (const r of (artifact.states ? artifact.states.records : [])) {
      if (!statesByUnit.has(r.unitID)) statesByUnit.set(r.unitID, []);
      statesByUnit.get(r.unitID).push({ t: toSec(r.frame), b: r.bits, sl: r.slow });
    }

    const units = (artifact.pos ? artifact.pos.units : []).map((u) => {
      const info = udef.get(u.defID);
      /* defID unresolvable in UDEF AND no spawn event: engine-side helper
         (terraform-era construction crutches — real units always spawn),
         renders as a forever-alive ghost circle, so drop it like terraunit.
         Kept when no UDEF section exists (lightweight fixtures). */
      if (info === undefined && udef.size > 0 && !spawnedUnitIds.has(u.unitID)) return null;
      let hpMax = 0;
      for (const s of u.samples) if (s.hp > hpMax) hpMax = s.hp;
      const commLevel = commLevelOfDef(info ? info.name : undefined);
      return {
        id: u.unitID, defID: u.defID,
        name: info ? (info.humanName || info.name) : undefined,
        def: info ? info.name : undefined,
        hpMax: hpMax > 0 ? hpMax : undefined,
        team: teamByUnit.has(u.unitID) ? teamByUnit.get(u.unitID) : 0,
        metalCost: info ? (info.metalCost ?? -1) : -1,
        /* effective value: leveled commanders add their morph costs on top
           of the recorded base cost; every other unit stays at metalCost */
        metalValue: info ? (commValueOfDef(info.name, info.metalCost ?? undefined) ?? info.metalCost ?? -1) : -1,
        commLevel,
        kind: info && info.canMove === false ? "str" : undefined,
        icon: info ? (info.iconType || (info.name ? info.name.toLowerCase() : undefined)) : undefined,
        /* value-class bucket for the per-player stats grid (econ/other/combat) */
        cls: info ? unitValueClass(info.name, info.iconType) : "combat",
        cloakRadius: info ? info.cloakRadius : undefined,
        /* Shield weapon radius/power; >= 200 elmos = area shield (circle),
           smaller personal shields only feed the fallback charge bar */
        shieldRadius: info ? info.shieldRadius : undefined,
        shieldPower: info ? info.shieldPower : undefined,
        /* anti-nuke interception radius in elmos — the viewer paints the
         * coverage circle of every completed antinuke, always */
        antiNuke: info ? info.antiNukeCoverage : undefined,
        /* sparse state track: [{t, b, sl}] — b bits: 1 fire, 2 disarm, 4 EMP;
         * sl = slow fraction (the purple dot fades in as slow stacks) */
        states: statesByUnit.get(u.unitID) ?? [],
        born: toSec(u.firstFrame),
        died: deathByUnit.has(u.unitID) ? toSec(deathByUnit.get(u.unitID)) : -1,
        /* ZK morph victim: no wreck marker under the live morphed unit */
        morph: morphIntoByUnit.has(u.unitID),
        /* silo missile launch (see MISSILE_UNIT_DEFS): staging-corner
           sample time; the page hides the unit from here on (warhead
           flight tells the story) and drops it from the loss grid */
        launched: launchTmByUnit.has(u.unitID),
        launchTm: launchTmByUnit.get(u.unitID) ?? -1,
        track: u.samples.map((s) => ({
          t: toSec(s.frame), x: s.x, y: s.z, hp: s.hp, bd: s.build,
          ck: s.ck,
          /* own area-cloak field active; undefined on artifacts packed
             before the field bit existed — the caller falls back to ck */
          cf: s.cf,
          /* own field stalled/unpowered (flashes red in the viewer) */
          cs: s.cs,
          /* shield charge fraction; undefined = no shield / not recorded */
          sh: s.sh,
        })),
      };
    }).filter((u) => u && !isExcludedDef(u.def));

    /* Wreck features (recorded from the next resim on): Spring spawns a
       *_dead/*_heap feature where a unit died and destroys it when it is
       reclaimed, so reclaimed wreckage really disappears. The engine's own
       metal value travels with the event. Once ANY wreck feature is
       recorded the layer shows exactly the field: ZK leaves no corpse for
       DGun/disintegrator and nanoframe-reclaim deaths, and no dot for
       those is correct in-game behavior, not a gap. Old artifacts without
       feature events fall back to death positions at ZK's 40% reclaim
       estimate (dyncomm wrecks are exactly cost*0.4; crushed *_heap-stage
       wrecks would be 20%) so the layer still renders. */
    const dimsW = artifact.meta && artifact.meta.map ? artifact.meta.map.dims : null;
    const wmw = dimsW && dimsW[0] > 0 ? dimsW[0] : 16384;
    const wmh = dimsW && dimsW[1] > 0 ? dimsW[1] : wmw;
    let nWreckEvents = 0;
    /* staging corpses are filtered by POSITION + TIME, never by position
       alone: real combat happens in map corners too (Otago: a Jumpjet
       Factory and two neighbours died inside the same bands), so a corner
       feature is staging carrion only when a LAUNCHED missile actually
       died around that frame (corpse and unit death are the same engine
       sweep). Artifacts with no missile launches keep every feature. */
    const missileDeathFrames = [...launchTmByUnit.keys()]
      .map((id) => (deathByUnit.has(id) ? deathByUnit.get(id) : -1))
      .filter((f) => f >= 0)
      .sort((a, b) => a - b);
    const nearMissileDeath = (f) => {
      if (!missileDeathFrames.length) return false;
      let lo = 0, hi = missileDeathFrames.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (missileDeathFrames[mid] < f) lo = mid + 1; else hi = mid;
      }
      const hi2 = missileDeathFrames[lo];
      const lo2 = lo > 0 ? missileDeathFrames[lo - 1] : hi2;
      return Math.abs(hi2 - f) <= 36 || Math.abs(lo2 - f) <= 36;
    };
    const wreckByFeature = new Map();
    for (const r of (artifact.evnt ? artifact.evnt.records : [])) {
      if (r.kind === "wreck") {
        nWreckEvents++;
        /* stockpile missiles destroyed at the staging corner leave their
           corpse OUTSIDE the playable map (measured on The Hole: all 150,
           at fraction 1/0 — a magenta dot wall at the map corner without
           this filter); gated on a matching missile death so the corner
           band alone can never eat a real wreck */
        if (r.int2 >= wmw * 0.95 && (r.int3 <= wmh * 0.05 || r.int3 >= wmh * 0.95) &&
            nearMissileDeath(r.frame)) continue;
        wreckByFeature.set(r.unitID, {
          born: toSec(r.frame),
          x: r.int2 / wmw, y: r.int3 / wmh,
          metal: Math.max(0, r.int1), gone: -1,
        });
      } else if (r.kind === "unwreck") {
        const w = wreckByFeature.get(r.unitID);
        if (w) w.gone = toSec(r.frame);
      }
    }
    let wrecks = [...wreckByFeature.values()];
    if (nWreckEvents === 0) {
      for (const u of units) {
        /* launched missiles staged at the corner leave no wreck at all:
           their "corpse" (if any) sits outside the playable map */
        if (u.died < 0 || u.morph || u.launched || !u.track || !u.track.length) continue;
        const last = u.track[u.track.length - 1];
        wrecks.push({
          born: u.died, x: last.x, y: last.y,
          metal: (u.metalCost > 0 ? u.metalCost : 0) * 0.4, gone: -1,
        });
      }
    }

    /* Spring recycles projectile IDs (u16 pools), so a byte-level "path" can
       be several unrelated flights concatenated by an older ingest. Real
       flights are probed every 6 frames — a >0.6 s hole in the sample
       stream means the first projectile is long dead: split there, so
       artifacts packed before the daemon-side fix render correctly too. */
    const PROJ_REUSE_GAP_FRAMES = 18;
    const projectiles = [];
    /* the sent strategic missiles get ZK's own incoming-strike visualisa-
     * tion (target circle + coloured head dot): Eos red, Shockley blue,
     * Zeno purple, Quake green, Inferno orange - Trinity shares Eos's
     * red. ZK names weapon defs "<unitkey>_<tag>", so match on the unit
     * KEY (the first underline token), never the whole string: the
     * Scylla's tactical-nuke torpedo is subtacmissile_tacnuke and a
     * substring match would give every torpedo launch a strategic-strike
     * target circle + fake Eos detonation (counter-review H1). */
    const MISSILE_COLORS = [
      ["tacnuke", "255,72,56"],
      ["empmissile", "72,214,255"],
      ["missileslow", "168,96,255"],
      ["seismic", "88,255,128"],
      ["napalmmissile", "255,138,40"],
      ["staticnuke", "255,72,56"],
    ];
    for (const p of (artifact.proj ? artifact.proj.paths : [])) {
      /* two flights get their own on-map marker (drawn as a slight
         team-coloured border by the page): the Trinity warhead and the
         antinuke's interceptor — everything else stays as the plain
         trail + blip. Key match on the unit-key prefix
         (staticnuke_crblmssl / staticantinuke_amd_rocket). The warhead
         uses the missile's own icon (nuke_missile.png, converted from
         ZK's icons/nuke_missile.dds), NOT the Trinity structure's. */
      const wf = wdef.get(p.weaponDefID);
      let flIcon;
      let mcol;
      let maoe = 0;
      if (wf) {
        const wkey = String(wf.name || "").toLowerCase().split("_")[0];
        if (wkey === "staticantinuke") flIcon = "antinuke_proj";
        else if (wkey === "staticnuke") flIcon = "nuke_missile";
        const mc = MISSILE_COLORS.find(([n]) => wkey === n);
        if (mc) { mcol = mc[1]; maoe = wf.aoe ?? 0; }
      }
      const mkPath = (seg) => ({
        proID: p.proID, cls: p.cls, clsName: PROJ_CLASS_NAME[p.cls] ?? "dropped",
        weaponDefID: p.weaponDefID, team: p.team, icon: flIcon,
        mcol, maoe,
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

    /* ---- superweapon events, missile explosions, ground napalm ---- */
    /* a superweapon nanoframe appearing is THE news of the game: the def
       names are ZK's own (raveparty/zenith/mahlazer/striderdetriment) plus
       the strategic nuke launcher (staticnuke, "Trinity") */
    const SUPERWEAPON_DEFS = new Set(["raveparty", "zenith", "mahlazer", "striderdetriment", "staticnuke"]);
    for (const r of (artifact.evnt ? artifact.evnt.records : [])) {
      if (r.kind !== "spawn") continue;
      const info = udef.get(r.int1);
      if (info && SUPERWEAPON_DEFS.has(info.name)) {
        feedData.push({
          tm: toSec(r.frame), cls: "news",
          txt: (info.humanName || info.name) + " has begun construction!",
        });
      }
    }

    /* Eos / Shockley / Quake / Inferno / Trinity: the stockpiled missile
       UNITS stage at the map corner between the launch command and liftoff,
       so their death position must NOT anchor the blast (and a silenced
       silo would paint a fake one at the corner). The real impact is the
       warhead PROJECTILE's last sample. ZK prefixes each weapon name with
       the unit key and often its own ("empmissile_emp_weapon",
       "seismic_seismic_weapon", "staticnuke_crblmssl"), so match on the
       unit KEY (the first underline token) - a substring would trap the
       Scylla's subtacmissile_tacnuke torpedo as an Eos strike. Radii: WDEF
       aoe when recorded, else the fixed game values (tacnuke 96, emp 140,
       seismic 320, napalmmissile 256, Trinity 960 elmos).
       fade "fast" = a wall-clock flash (~5 frames at any speed);
       "normal" = decays in sim seconds at the stated duration. */
    const EXPLOSION_DEFS = [
      ["tacnuke", { col: "255,72,56", r: 96, fade: "fast", dur: 0 }],
      ["empmissile", { col: "72,214,255", r: 140, fade: "fast", dur: 0 }],
      ["seismic", { col: "88,255,128", r: 320, fade: "fast", dur: 0 }],
      ["napalmmissile", { col: "255,138,40", r: 256, fade: "normal", dur: 8 }],
      /* Trinity, the strategic nuke launcher - same red, its 960-elmo blast.
         fx: the warhead's detonation paints the vector BLAST ART instead
         of the default AOE circle (the incoming-strike circles before
         impact still carry the exact radius) */
      ["staticnuke", { col: "255,72,56", r: 960, fade: "fast", dur: 0, fx: true }],
    ];
    const explosions = [];
    /* Zenith meteors are projectiles of the named "Meteor" weapondef; ground
       napalm patches are FIRE only — ZK's lups_napalm classification
       (weapon description / fx; the internal def names carry _napalm_ too,
       which doubles as the fallback for artifacts recorded before the nd
       flag existed). Zeno's slow field (missileslow) is area damage but
       NOT fire — it paints its own lingering purple patch. The Dante's
       black hole stays unpainted. Firewalker shells 64 elmos / 16 s,
       Inferno warheads 256 / 45 s, Zeno slow zones 320 / 30 s */
    const napalm = [];
    /* an antinuke intercept kills the warhead MID-AIR, and the warhead's
       flight would mark the intercept point as the strike - painting a
       fake full-radius ground detonation (counter-review M2). Altitude
       cannot tell it from a normal impact (tracked flights routinely end
       far above ground: the last probe precedes impact); what identifies
       a kill is the INTERCEPTOR: an amd_rocket flight whose own END
       coincides, in time and space, with the warhead's end - measured on
       The Hole, every real pair lands in the SAME probe frame (dt 0.00 s)
       at 19-256 elmos, while a missed rocket's target survives and its
       flight ends far away much later. */
    const ICEPT_SPAN_SEC = 0.3, ICEPT_RADIUS = 300;
    const rocketEnds = projectiles
      .filter((p) => {
        const w = wdef.get(p.weaponDefID);
        return w && String(w.name || "").toLowerCase().split("_")[0] === "staticantinuke" && p.path.length;
      })
      .map((p) => ({ t: p.end, x: p.path[p.path.length - 1].x, z: p.path[p.path.length - 1].z }));
    for (const p of projectiles) {
      if (!p.mcol || !p.path.length) continue;
      const imp = p.path[p.path.length - 1];
      if (rocketEnds.some((r) => Math.abs(r.t - p.end) <= ICEPT_SPAN_SEC
        && Math.hypot((r.x - imp.x) * wmw, (r.z - imp.z) * wmh) <= ICEPT_RADIUS)) {
        p.intercepted = true;
      }
    }
    /* ---- commanded destinations (PTGT) ----
       An antinuke-intercepted warhead's flight record just STOPS at the
       kill (the ion-intercept test kills happened at ignition: zero
       movement, no heading to extrapolate), so the strike circle must
       come from the RECORDED target, never from the path's end. Rows are
       per (pid, target); the latest row at-or-before the flight's end
       wins, so recycled proIDs never cross targets across flights. */
    const ptgtByPro = new Map();
    for (const t of (artifact.ptgt ?? [])) {
      if (!ptgtByPro.has(t.proID)) ptgtByPro.set(t.proID, []);
      ptgtByPro.get(t.proID).push(t);
    }
    for (const list of ptgtByPro.values()) list.sort((a, b) => a.frame - b.frame);
    for (const p of projectiles) {
      const rows = ptgtByPro.get(p.proID);
      if (!rows || !rows.length) continue;
      const endFrame = Math.round(p.end * FPS);
      let cand = null;
      for (const r of rows) {
        if (r.frame <= endFrame + 6) cand = r; else break;
      }
      if (cand) p.tgt = { x: cand.x, z: cand.z };
    }
    for (const p of projectiles) {
      const w = wdef.get(p.weaponDefID);
      if (!w || !p.path.length) continue;
      const imp = p.path[p.path.length - 1];
      const ex = w.name && EXPLOSION_DEFS.find(([n]) => String(w.name).toLowerCase().split("_")[0] === n);
      if (ex && !p.intercepted) {
        explosions.push({ t: imp.t, x: imp.x, y: imp.z, r: (w.aoe ?? 0) > 0 ? w.aoe : ex[1].r, col: ex[1].col, fade: ex[1].fade, dur: ex[1].dur, fx: ex[1].fx === true });
      }
      if (String(w.name) === "Meteor" && (w.aoe ?? 0) > 0) {
        explosions.push({ t: imp.t, x: imp.x, y: imp.z, r: w.aoe, col: "168,96,255", fade: "normal", dur: 8 });
      }
      const isFire = w.nd === 1 || /napalm/i.test(String(w.name || ""));
      /* fire shells' last PROBE sample can sit hundreds of elmos above
         impact (measured: real Firewalker/Kodachi/Dante flights end at
         15-700 elmos), so the mid-air-intercept gate applies ONLY to the
         strategic warheads (their tracked impacts all end at ~0), never
         to ground fire */
      if (isFire && (w.adr ?? 0) > 0) {
        napalm.push({ t: imp.t, x: imp.x, y: imp.z, r: w.adr, dur: (w.adu ?? 0) > 0 ? w.adu : 15 });
      }
      /* Zeno's slow field: same area-damage family as napalm but NOT fire
         (ZK marks it area_damage_is_slow) - impact leaves a lingering slow
         zone that decays in sim time. Radius/duration from WDEF when the
         recording widget provided them, else the fixed game values
         (missileslow: 320 elmos / 30 s); col paints it purple like the
         missile itself, the fire default stays orange */
      if (!p.intercepted && String(w.name || "").toLowerCase().split("_")[0] === "missileslow") {
        napalm.push({
          t: imp.t, x: imp.x, y: imp.z,
          r: (w.adr ?? 0) > 0 ? w.adr : 320,
          dur: (w.adu ?? 0) > 0 ? w.adu : 30,
          col: "168,96,255",
        });
      }
    }

    /* ---- launch news: every tracked strategic flight is a launch ----
       A warhead flight means the owning player actually fired. Same-type
       same-team launches within 2.5 s of each other are one volley ->
       one line ("24 x Eos missiles launched!"), not 24 identical rows;
       measured on The Hole: an Eos volley of 24 + a single early shot,
       50 Quake in two volleys, 38 Trinity warheads in groups. Trinity
       has no missile unit (the launcher is the building), so its launch
       line comes purely from the staticnuke flight. */
    const LAUNCH_MISSILE_NAMES = {
      tacnuke: "Eos", empmissile: "Shockley", missileslow: "Zeno",
      seismic: "Quake", napalmmissile: "Inferno",
    };
    const launches = [];
    for (const p of projectiles) {
      if (!p.mcol || !p.path.length) continue;
      const w = wdef.get(p.weaponDefID);
      const k = w && w.name ? String(w.name).toLowerCase().split("_")[0] : null;
      if (k && LAUNCH_MISSILE_NAMES[k]) {
        launches.push({ tm: p.born, nm: LAUNCH_MISSILE_NAMES[k], team: p.team, nuke: false });
      } else if (k === "staticnuke") {
        launches.push({ tm: p.born, nm: "Trinity", team: p.team, nuke: true });
      }
    }
    launches.sort((a, b) => a.tm - b.tm);
    for (let i = 0; i < launches.length;) {
      let j = i + 1;
      while (j < launches.length && launches[j].nm === launches[i].nm &&
             launches[j].team === launches[i].team &&
             launches[j].tm - launches[j - 1].tm <= 2.5) j++;
      const cnt = j - i, L = launches[i];
      feedData.push({
        tm: L.tm, cls: "launch",
        txt: L.nuke
          ? (cnt > 1 ? cnt + " × Trinity nukes launched!" : "Trinity launched a strategic nuke!")
          : (cnt > 1 ? cnt + " × " + L.nm + " missiles launched!" : L.nm + " launched!"),
      });
      i = j;
    }

    /* ---- death blasts (Skuttle-sized and up) ----
       ZK explodes every unit on death; this census covers the units whose
       explodeAs/selfDestructAs weapon carries areaOfEffect >= Skuttle's
       180 elmos (measured over zk-stable 2026-07: units/*.lua plus
       weapons/*.tdf - inline weaponDefs and TDF stock explosions both).
       The silo missile UNITS (Eos/Shockley/Quake/Inferno) are
       deliberately absent: their detonations come from the warhead
       FLIGHT impacts, and a missile killed in its silo leaves no blast
       in the replay story. The nuke ART (fx) goes on the three 1280-elmo
       death blasts: Detriment and Advanced Geothermal (both die through
       the very same NUCLEAR_MISSILE weapon, out-blasting the Trinity
       warhead's 960) and the Singularity Reactor (Naked Singularity).
       Dynamic commander defs are generated per level at runtime, so the
       pattern match below carries the chassis' 420-elmo blast to every
       dynXX<N>_ level. Everything else uses the neutral blast colour. */
    const NUKE_RED_LOCAL = "255,72,56";
    const DEATH_BLAST_DEFS = {
      "striderdetriment": { r: 1280, col: NUKE_RED_LOCAL, fx: true },   // Detriment
      "energysingu": { r: 1280, col: NUKE_RED_LOCAL, fx: true },   // Singularity Reactor - Naked Singularity, same 1280, shares the art
      "energyheavygeo": { r: 1280, col: NUKE_RED_LOCAL, fx: true },   // Advanced Geothermal
      "turretheavy": { r: 520 },   // Desolator (ESTOR_BUILDING)
      "turretantiheavy": { r: 520 },   // Lucifer (ESTOR_BUILDING)
      "turretaaheavy": { r: 520 },   // Artemis (ESTOR_BUILDING)
      "striderfunnelweb": { r: 520 },   // Funnelweb (ESTOR_BUILDING)
      "striderantiheavy": { r: 520 },   // Ultimatum (ESTOR_BUILDING)
      "energygeo": { r: 520 },   // Geothermal Generator (ESTOR_BUILDING)
      "bomberassault": { r: 520 },   // Odin (ESTOR_BUILDING)
      "amphbomb": { r: 500 },   // Limpet (AMPHBOMB_DEATH)
      "zenith": { r: 480 },   // Zenith (ATOMIC_BLAST)
      "striderbantha": { r: 480 },   // Paladin (ATOMIC_BLAST)
      "staticnuke": { r: 480 },   // Trinity (ATOMIC_BLAST)
      "staticheavyarty": { r: 480 },   // Big Bertha (ATOMIC_BLAST)
      "raveparty": { r: 480 },   // Disco Rave Party (ATOMIC_BLAST)
      "pw_hq_attacker": { r: 480 },   // Attacker Command (ATOMIC_BLAST)
      "pw_generic": { r: 480 },   // Generic Neutral Structure (ATOMIC_BLAST)
      "mahlazer": { r: 480 },   // Starlight (ATOMIC_BLAST)
      "energyfusion": { r: 480 },   // Fusion Reactor (ATOMIC_BLAST)
      "striderhub": { r: 420 },   // Strider Hub (ESTOR_BUILDINGEX)
      "obj_artefact": { r: 420 },   // Ancient Artefact (ESTOR_BUILDINGEX)
      "energypylon": { r: 420 },   // Energy Pylon (ESTOR_BUILDINGEX)
      "dynsupport1": { r: 420 },   // Engineer Commander (ESTOR_BUILDINGEX)
      "dynstrike1": { r: 420 },   // Strike Commander (ESTOR_BUILDINGEX)
      "dynrecon1": { r: 420 },   // Recon Commander (ESTOR_BUILDINGEX)
      "dynassault1": { r: 420 },   // Guardian Commander (ESTOR_BUILDINGEX)
      "cremcom1": { r: 420 },   // Commander (ESTOR_BUILDINGEX)
      "corcom1": { r: 420 },   // Battle Commander (ESTOR_BUILDINGEX)
      "commsupport1": { r: 420 },   // Support Commander (ESTOR_BUILDINGEX)
      "commstrike1": { r: 420 },   // Strike Commander (ESTOR_BUILDINGEX)
      "commrecon1": { r: 420 },   // Recon Commander (ESTOR_BUILDINGEX)
      "benzcom1": { r: 420 },   // Siege Commander (ESTOR_BUILDINGEX)
      "armcom1": { r: 420 },   // Strike Commander (ESTOR_BUILDINGEX)
      "shieldbomb": { r: 384 },   // Snitch (shieldbomb_DEATH)
      "cloakbomb": { r: 352 },   // Imp (cloakbomb_DEATH)
      "turretsunlance": { r: 340 },   // Sunlance (LARGE_BUILDINGEX)
      "turretriot": { r: 340 },   // Stardust (LARGE_BUILDINGEX)
      "turretaafar": { r: 340 },   // Chainsaw (LARGE_BUILDINGEX)
      "staticrearm": { r: 340 },   // Airpad (LARGE_BUILDINGEX)
      "staticmissilesilo": { r: 340 },   // Missile Silo (LARGE_BUILDINGEX)
      "staticarty": { r: 340 },   // Cerberus (LARGE_BUILDINGEX)
      "staticantinuke": { r: 340 },   // Antinuke (LARGE_BUILDINGEX)
      "nebula": { r: 340 },   // Nebula (LARGE_BUILDINGEX)
      "gunshipkrow": { r: 340 },   // Krow (LARGE_BUILDINGEX)
      "factoryveh": { r: 340 },   // Rover Assembly (LARGE_BUILDINGEX)
      "factorytank": { r: 340 },   // Tank Foundry (LARGE_BUILDINGEX)
      "factoryspider": { r: 340 },   // Spider Factory (LARGE_BUILDINGEX)
      "factoryship": { r: 340 },   // Shipyard (LARGE_BUILDINGEX)
      "factoryshield": { r: 340 },   // Shieldbot Factory (LARGE_BUILDINGEX)
      "factoryplane": { r: 340 },   // Airplane Plant (LARGE_BUILDINGEX)
      "factoryjump": { r: 340 },   // Jumpbot Factory (LARGE_BUILDINGEX)
      "factoryhover": { r: 340 },   // Hovercraft Platform (LARGE_BUILDINGEX)
      "factorygunship": { r: 340 },   // Gunship Plant (LARGE_BUILDINGEX)
      "factorycloak": { r: 340 },   // Cloakbot Factory (LARGE_BUILDINGEX)
      "factoryamph": { r: 340 },   // Amphbot Factory (LARGE_BUILDINGEX)
      "striderarty": { r: 320 },   // Merlin (ATOMIC_BLASTSML)
      "shipcarrier": { r: 320 },   // Reef (ATOMIC_BLASTSML)
      "plateveh": { r: 294 },   // Rover Plate (FAC_PLATEEX)
      "platetank": { r: 294 },   // Tank Plate (FAC_PLATEEX)
      "platespider": { r: 294 },   // Spider Plate (FAC_PLATEEX)
      "plateship": { r: 294 },   // Ship Plate (FAC_PLATEEX)
      "plateshield": { r: 294 },   // Shieldbot Plate (FAC_PLATEEX)
      "plateplane": { r: 294 },   // Airplane Plate (FAC_PLATEEX)
      "platejump": { r: 294 },   // Jumpbot Plate (FAC_PLATEEX)
      "platehover": { r: 294 },   // Hovercraft Plate (FAC_PLATEEX)
      "plategunship": { r: 294 },   // Gunship Plate (FAC_PLATEEX)
      "platecloak": { r: 294 },   // Cloakbot Plate (FAC_PLATEEX)
      "plateamph": { r: 294 },   // Amphbot Plate (FAC_PLATEEX)
      "commander_egg": { r: 280 },   // Commander Egg (COMMANDER_EGG_EMP)
      "turrettorp": { r: 260 },   // Urchin (MEDIUM_BUILDINGEX)
      "turretimpulse": { r: 260 },   // Newton (MEDIUM_BUILDINGEX)
      "turretheavylaser": { r: 260 },   // Stinger (MEDIUM_BUILDINGEX)
      "turretemp": { r: 260 },   // Faraday (MEDIUM_BUILDINGEX)
      "turretaaflak": { r: 260 },   // Thresher (MEDIUM_BUILDINGEX)
      "hoverarty": { r: 260 },   // Lance (MEDIUM_BUILDINGEX)
      "striderscorpion": { r: 256 },   // Scorpion (CRAWL_BLASTSML)
      "striderdante": { r: 256 },   // Dante (CRAWL_BLASTSML)
      "turretlaser": { r: 180 },   // Lotus (SMALL_BUILDINGEX)
      "turretgauss": { r: 180 },   // Gauss (SMALL_BUILDINGEX)
      "turretaalaser": { r: 180 },   // Razor (SMALL_BUILDINGEX)
      "turretaaclose": { r: 180 },   // Hacksaw (SMALL_BUILDINGEX)
      "staticstorage": { r: 180 },   // Storage (SMALL_BUILDINGEX)
      "staticsonar": { r: 180 },   // Sonar Station (SMALL_BUILDINGEX)
      "staticradar": { r: 180 },   // Radar Tower (SMALL_BUILDINGEX)
      "staticmex": { r: 180 },   // Metal Extractor (SMALL_BUILDINGEX)
      "staticheavyradar": { r: 180 },   // Advanced Radar (SMALL_BUILDINGEX)
      "jumpbomb": { r: 180 },   // Skuttle (jumpbomb_DEATH)
      "energywind": { r: 180 },   // Wind/Tidal Generator (SMALL_BUILDINGEX)
      "energysolar": { r: 180 },   // Solar Collector (SMALL_BUILDINGEX)
    };
    for (const u of units) {
      if (u.died < 0 || u.morph) continue;
      const db = DEATH_BLAST_DEFS[u.def ?? ""] ??
        (/^dyn[a-z]+[1-9]\d*_/.test(u.def ?? "") ? { r: 420 } : null);
      if (!db) continue;
      /* an unfinished nanoframe crumples - it does not go up in its full
         death blast; the table is for complete units */
      const last = u.track.length ? u.track[u.track.length - 1] : null;
      if (!last || (last.bd !== undefined && last.bd < 0.99)) continue;
      explosions.push({ t: u.died, x: last.x, y: last.y, r: db.r,
        col: db.col ?? "255,150,90", fade: "fast", dur: 0,
        fx: db.fx === true });
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

    /* resolved votes leave a line in the feed history; pre-game lobby polls
       (endTm < 0, resolved before STARTPLAYING) leave no in-game line */
    for (const row of votes) {
      if (row.endTm !== null && row.endTm >= 0) {
        feedData.push({
          tm: row.endTm, cls: "vote",
          txt: "Vote: " + row.subject + " — " + (row.success === undefined ? "ended" : row.success ? "passed" : "failed"),
        });
      }
    }
    feedData.sort((a, b) => a.tm - b.tm);

    const posEnd = artifact.pos ? artifact.pos.maxFrame : 0;
    const projEnd = artifact.proj ? artifact.proj.maxFrame : 0;
    const linkEnd = artifact.link ? artifact.link.maxFrame : 0;
    // resim sections run on the play clock already - never anchor-shifted
    const endTime = toPlay(Math.max(endFrame, posEnd, projEnd, linkEnd));
    // META.gameTime is play seconds (demo header field counts from play
    // start, matching the resim's last sim frame / 30) - never shifted
    const metaEnd = artifact.meta && artifact.meta.gameTime ? artifact.meta.gameTime : 0;
    const dims = artifact.meta && artifact.meta.map ? artifact.meta.map.dims : null;

    /* map metal spots (MESP section, written by the widget from the ZK mex
       gadget's rules params); elmos -> map fractions for canvas drawing */
    const mespDimW = dims && dims[0] > 0 ? dims[0] : 16384;
    const mespDimH = dims && dims[1] > 0 ? dims[1] : mespDimW;
    const metalSpots = (artifact.metalSpots && Array.isArray(artifact.metalSpots.spots) ? artifact.metalSpots.spots : [])
      .filter((s) => Array.isArray(s) && s.length >= 2 && isFinite(s[0]) && isFinite(s[1]))
      .map((s) => ({ x: s[0] / mespDimW, y: s[1] / mespDimH, metal: s[2] > 0 ? s[2] : undefined }));

    return {
      fps: FPS,
      hasUnits: units.length > 0,
      units, projectiles, links, ecoPts, feedData,
      /* wreck layer: engine-recorded feature lifetimes when present,
         else synthesized from unit deaths (est. 40% of build cost) */
      wrecks,
      winner, winnerLabel,
      startPolys,
      teamNames, teamMeta, players, chatData,
      votes, metalSpots,
      /* superweapon detonations (Eos/Shockley/Quake/Inferno + Zenith
         meteors) and ground napalm patches — page paints both on the map */
      explosions, napalm,
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

  /** Contain-fit the map's rectangle into a canvas of cw x ch DEVICE px,
   *  preserving the map's true aspect ratio (The Hole is square, Otago is
   *  wide - both must render undistorted, letterboxed against the panel).
   *  Returns the fitted rect {ox, oy, fw, fh}; missing dims default to a
   *  square map. Pure and unit-tested - the page zooms/pans around it. */
  function mapFitRect(mapW, mapH, cw, ch) {
    const ar = mapW > 0 && mapH > 0 ? mapW / mapH : 1;
    const fw = Math.min(cw, ch * ar);
    const fh = Math.min(ch, cw / ar);
    return { ox: (cw - fw) / 2, oy: (ch - fh) / 2, fw, fh };
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
      cf: near.cf,
      cs: near.cs,
      sh: near.sh,
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
    parse, artifactToModel, trackAt, pathAt, mapFitRect,
    parseStartboxes, parseStartboxesBlob, setUnitIconBase, iconFor, tintIcon, outlineIcon,
    teamColor, hpColor, hslToRgb, damageShade, shieldColor, TEAL16, WARM16,
    EXCLUDED_UNIT_DEFS, unitValueClass,
    commLevelOfDef, commValueOfDef, COMM_MORPH_BASE_COSTS,
    FPS, PROJ_CLASS_NAME, EVNT_KIND_NAME, STARTBOX_FADE_SEC,
    MORPH_PAIR_WINDOW_SEC,
  };
})(typeof window !== "undefined" ? window : globalThis);
