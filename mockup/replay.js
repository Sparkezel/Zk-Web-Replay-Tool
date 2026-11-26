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
  const EVNT_KIND_NAME = ["spawn", "death", "finished", "transfer", "gameover", "wreck", "unwreck", "engage"];
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

  /** carrier-spawn drones (Reef/carrier pads: dronelight = Firefly,
   *  droneheavyslow = Viper, dronefighter = Spicula, dronecarry = Gull):
   *  unlike terraunit they ARE real map units and stay rendered, but their
   *  deaths are excluded from the battle feed and the stats grid — a
   *  drone skirmish is 40+ feed rows of noise that also skews the
   *  units/loss aggregates (#36). Chicken-mode `chicken_drone*` is a
   *  genuine combat unit and stays. */
  const DRONE_UNIT_DEFS = new Set(["dronelight", "droneheavyslow", "dronefighter", "dronecarry"]);
  function isDroneDef(defName) {
    return DRONE_UNIT_DEFS.has(String(defName || "").toLowerCase());
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
       until they fly (in flight they become the coloured warhead dots).
       "stealth" likewise resolves to icons/sniper.dds (size 1.6); the
       game ships no stealth.* of its own */
    if (iconType === "cruisemissilesmall") iconType = "cruisemissile";
    if (iconType === "stealth") iconType = "sniper";
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

  /* ZK's own per-iconType SIZE (LuaUI/Configs/icontypes.lua, "size" field,
     Spring's standard icons draw at size 2.0): the game itself renders a
     Phantom (sniper, 2.4) visibly larger than a Scythe (stealth, 1.6) even
     though both use sniper.dds, a Missile Silo (cruisemissile, 2.5) 2.5x its
     stockpiled missiles (cruisemissilesmall, 1.0), and superweapons
     (nuke/antinuke 3.0, singu 3.2) as landmarks. The viewer honours the same
     ratios so the map reads like the game. Lookup uses the RAW iconType:
     "stealth" aliases to sniper ART but keeps its own 1.6 size, exactly as
     ZK draws it. Entries below = every iconType used by the tracked replays
     (220/224 across the six tracked replays; "none", "default",
     "submarine" and "vanquisher" have no entry and read as the neutral 2.0). */
  const ICON_TYPE_SIZE = {
    advradar:2.5,amphaa:1.8,ampharty:2,amphassault:2.6,amphbomb:1.9,
    amphraider:1.9,amphskirm:1.8,amphsupport:1.9,amphtorpraider:1.9,
    amphtorpriot:2.2,amphtransport:2.2,antinuke:3,bomberassault:2.1,
    bomberassaultshield:2.5,bombernuke:2.5,bomberraider:2.1,bomberriot:2.1,
    bomberskirm:2.1,builder:1.8,builderair:1.8,building:0.8,chicken:1.4,
    chickena:2.1,chickenc:1.8,chickendodo:1.4,chickenf:2.2,
    chickenleaper:1.8,chickenminiq:3.5,chickenq:5,chickenr:1.6,chickens:1.6,
    clogger:2,commander0:1.9,commander1:2,commander2:2.2,commander3:2.4,
    commander4:2.6,commander5:2.8,commander_egg:1.9,corcommander:2,
    cruisemissile:2.5,cruisemissilesmall:1,defense:2,defenseaa:2,
    defenseheavy:2,defenseraider:2,defenseriot:2,defenseshield:2,
    defenseskirm:2,defenseskirmaa:2,defensespecial:2,defensesupport:2,
    defensetorp:2,energy_med:2.1,energyfusion:2,energygeo:2,
    energyheavygeo:2.4,energysingu:3.2,energywind:2,facair:2.6,facamph:2.6,
    facgunship:2.6,fachover:2.6,facjumpjet:2.6,fackbot:2.6,facship:2.6,
    facspider:2.6,factank:2.6,facvehicle:2.6,facwalker:2.6,fatbotarty:2.1,
    fatbotsupport:1.8,fighter:1.5,fixedtachyon:2,gunship:2,gunshipaa:2,
    gunshipraider:2,gunshipscout:1.5,gunshipskirm:2,gunshipspecial:1.5,
    gunshiptransport:2,heavygunship:2.4,heavygunshipassault:2.4,
    heavygunshipskirm:2.4,heavygunshiptransport:2.4,heavysam:2.2,
    hoveraa:1.8,hoverassault:1.8,hoverraider:1.8,hoverriot:1.8,
    hoverscout:1.8,hoverskirm:1.8,hoverspecial:1.8,jumpjetaa:1.8,
    jumpjetassault:1.8,jumpjetbomb:1.8,jumpjetraider:1.8,kbotaa:1.8,
    kbotarty:1.8,kbotassault:2,kbotbomb:1.8,kbotjammer:2,kbotraider:1.8,
    kbotriot:1.8,kbotskirm:1.8,kbotwideriot:2,krogoth:3,lrpc:2.4,mahlazer:3,
    mahlazer_special:2.8,mex:1.1,mine:1.2,mobiletachyon:2.3,nebula:4,nuke:3,
    padair:2.15,padamph:2.15,padbot:2.15,padgunship:2.15,padhover:2.15,
    padjumpjet:2.15,padship:2.15,padspider:2.15,padtank:2.15,padveh:2.15,
    padwalker:2.15,pw_assault:3,pw_assault_small:2.1,pw_bomberfac:3.4,
    pw_defense:3,pw_defense2:3.2,pw_dropfac:3.2,pw_energy:2.7,
    pw_energy2:3.2,pw_interception:3,pw_jammer:3,pw_metal:2.7,pw_relay:2,
    pw_riot:3,pw_special:2.7,pw_warpgate:3,pw_wormhole:2.7,pw_wormhole2:3,
    pylon:1.8,radar:2,radarplane:2,satellite:3,scoutplane:1.6,shipaa:3,
    shiparty:3,shipassault:2.8,shipcarrier:4,shipheavyarty:4,shipriot:2.8,
    shipscout:2.2,shipskirm:2.8,shiptorpraider:2.2,smallgunship:1.4,
    sniper:2.4,sonar:2,special:1.6,spideraa:1.8,spiderassault:1.8,
    spiderbomb:1.8,spidergeneric:1.8,spiderriot:1.8,spiderriotspecial:1.8,
    spiderscout:1.7,spiderskirm:1.8,spiderspecialscout:2,spidersupport:2.4,
    staticaa:2,staticarty:2.2,staticassault:1.8,staticassaultriot:2,
    staticbuilder:1.5,staticjammer:2,staticskirmaa:2,statictransport:1.4,
    stealth:1.6,stealthfighter:1.7,storage:1,subraider:3,subtacmissile:4,
    supergunship:2.8,t3arty:2.7,t3builder:1.8,t3generic:2.9,t3hub:2.4,
    t3jumpjetriot:2.4,t3riot:2.6,t3spiderbuilder:2.7,t3spidergeneric:2.7,
    tankaa:2,tankarty:2,tankassault:2,tanklrarty:2.2,tankraider:2,
    tankriot:2,tankscout:2,tankskirm:2.3,tempshield:1.2,vehicleaa:1.8,
    vehiclearty:1.8,vehicleassault:1.8,vehiclelrarty:2.2,vehicleraider:1.8,
    vehicleriot:1.8,vehiclescout:1.8,vehiclespecial:2.1,vehiclesupport:1.8,
    walkeraa:1.6,walkerassault:1.7,walkerbomb:1.8,walkerlrarty:2,
    walkerraider:1.6,walkerriot:1.6,walkershield:2,walkerskirm:1.7,
    walkersupport:2,
  };
  function iconSize(iconType) {
    const s = ICON_TYPE_SIZE[String(iconType || "").toLowerCase()];
    return s === undefined ? 2 : s;
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

  /* POS decode is TYPED-ARRAY (structure-of-arrays): one set of column
     buffers per unit instead of an object per sample. The file already
     stores 9 bytes per sample; the old decode inflated that to ~100-130
     bytes of heap objects (~25M objects on the stress replay — >8 GB,
     multi-second GC pauses). Columns:
       t  Float32  seconds (frame / 30)
       x  Float32  map-x fraction
       y  Float32  map-z fraction
       hp Uint8    raw 0..255 (fraction = /255, converted in trackAt)
       bd Uint8    raw 0..255
       fl Uint8    bit0 cloaked, bit1 own area-field active, bit2 stalled
       sh Uint8    raw 0..254 charge, 255 = unknown/no shield
     v1/v2 artifacts only ever carry bit0; cf/cs read back as undefined
     (the track keeps the section version for that decision). */
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
      const n = sampleCount;
      const t = new Float32Array(n), x = new Float32Array(n), y = new Float32Array(n);
      const hp = new Uint8Array(n), bd = new Uint8Array(n), fl = new Uint8Array(n), sh = new Uint8Array(n);
      /* v1/v2 sections carry no shield byte: the column stays at the
         "unknown" sentinel, so trackAt reads sh as undefined (0 would
         paint a fully-drained red shield on every pre-v3 shield unit) */
      if (version < 3) sh.fill(255);
      let cx = originX, cz = originZ;
      let frame = firstFrame;
      for (let k = 0; k < n; k++) {
        cx += dv.getInt16(o, true) / 65535; o += 2;
        cz += dv.getInt16(o, true) / 65535; o += 2;
        if (version >= 2) {
          frame += dv.getInt16(o, true); o += 2;
        } else {
          frame = firstFrame + k * POS_PROBE_EVERY;
        }
        t[k] = frame / 30;
        x[k] = cx;
        y[k] = cz;
        // sample layout: dX, dZ, frameDelta, u8 hp, u8 build, [u8 flags, u8 shield]
        hp[k] = u8[o]; o += 1;
        bd[k] = u8[o]; o += 1;
        if (version >= 3) {
          fl[k] = u8[o] & 7; o += 1;
          sh[k] = u8[o]; o += 1;
        } else if (version === 2) {
          fl[k] = u8[o] & 1; o += 1;
        } else {
          fl[k] = 0;
        }      }
      p.units.push({ unitID, defID, firstFrame,
        samples: { n, t, x, y, hp, bd, fl, sh, v3: version >= 3 } });
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
      /* columnar, same rationale as decodePos: t seconds, x/z map
         fractions, y the raw height fraction. Row 0 is the origin. */
      const m = sampleCount + 1;
      const t = new Float32Array(m), x = new Float32Array(m), y = new Float32Array(m), z = new Float32Array(m);
      t[0] = startFrame / 30;
      x[0] = ox; y[0] = oy; z[0] = oz;
      let cx = ox, cz = oz;
      let frame = startFrame;
      for (let k = 1; k < m; k++) {
        cx += dv.getInt16(o, true) / 65535; o += 2;
        cz += dv.getInt16(o, true) / 65535; o += 2;
        const cy = dv.getInt16(o, true) / 65535; o += 2;
        if (version >= 2) {
          frame += dv.getInt16(o, true); o += 2;
        } else {
          frame = startFrame + k * POS_PROBE_EVERY;
        }
        t[k] = frame / 30;
        x[k] = cx; y[k] = cy; z[k] = cz;
      }
      p.paths.push({ proID, weaponDefID, cls, team: ownerTeam, startFrame, samples: { n: m, t, x, y, z } });
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
  /* STAT decode columnar too — the stress replay carries ~13.8M state rows,
     which as objects would alone outweigh the whole typed-array POS gain */
  function decodeStates(dv, u8) {
    const p = { records: null };
    if (u8.length < 4) return p;
    let o = 0;
    const n = dv.getUint32(o, true); o += 4;
    const unitID = new Uint32Array(n), bits = new Uint8Array(n);
    const t = new Float32Array(n), sl = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      t[i] = dv.getUint32(o, true) / 30; o += 4;
      unitID[i] = dv.getUint32(o, true); o += 4;
      bits[i] = u8[o]; o += 1;
      sl[i] = u8[o] / 16; o += 1;
    }
    p.records = { n, t, unitID, bits, sl };
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
        if (!u.samples.n || isExcludedDef(defNameOfUnit(u.unitID))) continue;
        lastBuildByUnit.set(u.unitID, u.samples.bd[u.samples.n - 1] / 255);
        const team = teamByUnit.has(u.unitID) ? teamByUnit.get(u.unitID) : 0;
        (spawnsByTeam[team] = spawnsByTeam[team] || []).push({
          unitID: u.unitID, t: toSec(u.firstFrame),
          x: u.samples.x[0], y: u.samples.y[0],
          b0: u.samples.bd[0] / 255,
        });
      }
      for (const list of Object.values(spawnsByTeam)) list.sort((a, b) => a.t - b.t);
      for (const u of (artifact.pos ? artifact.pos.units : [])) {
        if (!u.samples.n || !deathByUnit.has(u.unitID)) continue;
        if (isExcludedDef(defNameOfUnit(u.unitID))) continue;
        if ((lastBuildByUnit.get(u.unitID) ?? 1) < 0.99) continue;
        /* a morph victim destroys itself: a real kill (killer >= 0) is a
           kill even when a same-spot spawn coincides within the window */
        if ((killerByUnit.get(u.unitID) ?? -1) >= 0) continue;
        const team = teamByUnit.has(u.unitID) ? teamByUnit.get(u.unitID) : 0;
        const list = spawnsByTeam[team];
        if (!list) continue;
        const diedT = toSec(deathByUnit.get(u.unitID));
        const last = { x: u.samples.x[u.samples.n - 1], z: u.samples.y[u.samples.n - 1] };
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
      const sp = uu.samples;
      for (let k = 0; k < sp.n; k++) {
        if (sp.x[k] > 0.95 && (sp.y[k] < 0.05 || sp.y[k] > 0.95)) {
          launchTmByUnit.set(uu.unitID, sp.t[k]);
          break;
        }
      }
    }
    for (const r of (artifact.evnt ? artifact.evnt.records : [])) {
      if (r.kind !== "death") continue;
      const deadDef = defByUnit.has(r.unitID) ? udef.get(defByUnit.get(r.unitID)) : null;
      if (isExcludedDef(deadDef && deadDef.name)) continue;
      /* carrier drones die by the dozen; their feed rows would drown out
         the units that matter (issue #36) — the drones stay on the map */
      if (isDroneDef(deadDef && deadDef.name)) continue;
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
    /* group the flat STAT columns into per-unit columns: {n, t, b, sl} */
    const statesByUnit = new Map();
    {
      const st = artifact.states ? artifact.states.records : null;
      if (st) {
        const buckets = new Map();
        for (let i = 0; i < st.n; i++) {
          const uid = st.unitID[i];
          if (!buckets.has(uid)) buckets.set(uid, []);
          buckets.get(uid).push(i);
        }
        for (const [uid, idx] of buckets) {
          const m = idx.length;
          const t = new Float32Array(m), b = new Uint8Array(m), sl = new Float32Array(m);
          for (let k = 0; k < m; k++) {
            t[k] = st.t[idx[k]];
            b[k] = st.bits[idx[k]];
            sl[k] = st.sl[idx[k]];
          }
          statesByUnit.set(uid, { n: m, t, b, sl });
        }
      }
    }

    const units = (artifact.pos ? artifact.pos.units : []).map((u) => {
      const info = udef.get(u.defID);
      /* defID unresolvable in UDEF AND no spawn event: engine-side helper
         (terraform-era construction crutches — real units always spawn),
         renders as a forever-alive ghost circle, so drop it like terraunit.
         Kept when no UDEF section exists (lightweight fixtures). */
      if (info === undefined && udef.size > 0 && !spawnedUnitIds.has(u.unitID)) return null;
      let hpMax = 0;
      for (let k = 0; k < u.samples.n; k++) if (u.samples.hp[k] > hpMax) hpMax = u.samples.hp[k];
      hpMax = hpMax / 255;
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
        /* carrier-spawn drones (Firefly/Viper/Spicula/Gull): real map
         * units, but excluded from the feed and the stats grid — they
         * die by the dozen and drown out the units that matter (#36) */
        drone: info ? isDroneDef(info.name) : false,
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
        /* the COLUMNAR track straight from the decoder — zero-copy: the old
           .map() doubled peak memory per artifact. Fields read via
           trackAt (fractions + flag semantics incl. v2 cf/cs undefined) */
        track: u.samples,
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
    /* staging corpses stay dead even if a later MOVEMENT row arrives for
       the same feature id — without this the update row would resurrect
       the filtered-out corpse at its (in-map) resting position */
    const wreckSkipped = new Set();
    for (const r of (artifact.evnt ? artifact.evnt.records : [])) {
      if (r.kind === "wreck") {
        nWreckEvents++;
        /* stockpile missiles destroyed at the staging corner leave their
           corpse OUTSIDE the playable map (measured on The Hole: all 150,
           at fraction 1/0 — a magenta dot wall at the map corner without
           this filter); gated on a matching missile death so the corner
           band alone can never eat a real wreck */
        if (r.int2 >= wmw * 0.95 && (r.int3 <= wmh * 0.05 || r.int3 >= wmh * 0.95) &&
            nearMissileDeath(r.frame)) { wreckSkipped.add(r.unitID); continue; }
        if (wreckSkipped.has(r.unitID)) continue;
        const w = wreckByFeature.get(r.unitID);
        if (w) {
          /* movement update (aircraft wrecks: the feature is created at
             the in-air death spot, then falls/tumbles to rest — the
             recorder re-emits wrk rows while it moves). x/y track the
             LATEST row so the zone clustering sees the resting spot */
          w.pts.push([toSec(r.frame), r.int2 / wmw, r.int3 / wmh]);
          w.x = r.int2 / wmw; w.y = r.int3 / wmh;
        } else {
          wreckByFeature.set(r.unitID, {
            born: toSec(r.frame),
            x: r.int2 / wmw, y: r.int3 / wmh,
            metal: Math.max(0, r.int1), gone: -1,
            pts: [[toSec(r.frame), r.int2 / wmw, r.int3 / wmh]],
          });
        }
      } else if (r.kind === "unwreck") {
        const w = wreckByFeature.get(r.unitID);
        if (w) w.gone = toSec(r.frame);
      }
    }
    /* only MOVING wrecks need the time lookup — everything else keeps its
       plain x/y (and the synthetic fallback wrecks below never move) */
    for (const w of wreckByFeature.values()) {
      if (w.pts.length > 1) {
        w.posAt = (tm) => {
          let lo = 0, hi = w.pts.length - 1;
          if (tm < w.pts[0][0]) return { x: w.pts[0][1], y: w.pts[0][2] };
          while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (w.pts[mid][0] <= tm) lo = mid; else hi = mid - 1; }
          return { x: w.pts[lo][1], y: w.pts[lo][2] };
        };
      }
    }
    let wrecks = [...wreckByFeature.values()];
    if (nWreckEvents === 0) {
      for (const u of units) {
        /* launched missiles staged at the corner leave no wreck at all:
           their "corpse" (if any) sits outside the playable map */
        if (u.died < 0 || u.morph || u.launched || !u.track || !u.track.n) continue;
        const last = { x: u.track.x[u.track.n - 1], y: u.track.y[u.track.n - 1] };
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
      /* columnar segment view: flights share the parent path's buffers via
         subarray (zero-copy); splitting only happens on proID reuse */
      const mkPath = (from, to) => {
        const segN = to - from;
        return {
          proID: p.proID, cls: p.cls, clsName: PROJ_CLASS_NAME[p.cls] ?? "dropped",
          weaponDefID: p.weaponDefID, team: p.team, icon: flIcon,
          wname: wf ? String(wf.name || "").toLowerCase() : "",
          mcol, maoe,
          born: p.samples.t[from],
          end: p.samples.t[to - 1],
          path: {
            n: segN,
            t: p.samples.t.subarray(from, to),
            x: p.samples.x.subarray(from, to),
            y: p.samples.y.subarray(from, to),
            z: p.samples.z.subarray(from, to),
          },
        };
      };
      if (!p.samples.n) continue;
      const sp = p.samples;
      let segStart = 0;
      for (let i = 1; i < sp.n; i++) {
        /* the t column is Float32 seconds, so the gap lands on the HALF-frame
           midpoint between the integer frame gaps: an exactly-18-frame gap
           (3 missed probes) still merges like the old integer rule, 19+ still
           splits - raw (t[i]-t[i-1])*30 > 18 flipped on 60% of exact-18 gaps
           under the rounding (measured) */
        if ((sp.t[i] - sp.t[i - 1]) * 30 > PROJ_REUSE_GAP_FRAMES + 0.5) {
          projectiles.push(mkPath(segStart, i));
          segStart = i;
        }
      }
      projectiles.push(mkPath(segStart, sp.n));
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

    /* ---- engagements: who is fighting whom ---------------------------
       Each "engage" row says: attacker u landed damage on victim v at
       frame f. The widget emits on victim CHANGE plus a keep-alive every
       0.6 s, so at any playback time the attacker's current target is
       the LATEST row at-or-before tm whose keep-alive has not expired:
       the arrow layer TTLs out ~1.2 s after the last hit (rows refresh
       twice per TTL, so an ongoing fight never flickers). Rows are
       shape-sorted per attacker; old artifacts carry no use rows and
       simply paint nothing. */
    const ENGAGE_TTL = 1.2;
    /* the same artillery census as the recorder's ENG_ARTY_DEFS (every ZK
       unit whose description says artillery): their damage already shows as
       flight arcs; arrows to targets a map away are noise. Sling, Racketeer,
       Impaler and Phantom are REINSTATED by user ruling - they are not in
       this list and draw arrows again, coloured by the viewer's arrow styles.
       Filtering here too keeps ARTIFACTS RECORDED BEFORE THE WIDGET FIX
       clean */
    const ENG_ARTY_DEFS = new Set([
      "hoverarty", "jumparty", "shiparty", "shipheavyarty", "staticarty",
      "striderarty", "tankarty", "tankheavyarty", "veharty",
      "chickenblobber", "chickenr", "chickenspire",
    ]);
    const unitDefName = new Map();
    for (const u of units) unitDefName.set(u.id, u.def);
    const engagements = {};
    for (const r of (artifact.evnt ? artifact.evnt.records : [])) {
      if (r.kind !== "engage") continue;
      if (ENG_ARTY_DEFS.has(unitDefName.get(r.unitID) ?? "")) continue;
      (engagements[r.unitID] = engagements[r.unitID] || []).push({ t: toSec(r.frame), v: r.int1 });
    }
    for (const k of Object.keys(engagements)) {
      engagements[k].sort((a, b) => a.t - b.t);
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
    /* impact AoE circles for the NON-strategic big guns: Big Bertha's
       plasma, the disco's colour-in-the-name cannons (DRP is rare, the
       rainbow reads well) and Dante's rocket volleys. Radius from the
       recorded WDEF aoe (Spring's damageAreaOfEffect - the RADIUS, half
       the lua areaOfEffect diameter: measured Dante 168->84, roaster
       800->400 on real artifacts), else the halved fixed values below in
       the same convention as the strategic table; each decays in sim
       time over the stated (short) seconds; colour matches the weapon's
       NAME (red killer -> red ...) or, for Bertha, its plasma */
    const IMPACT_BLAST_DEFS = [
      ["raveparty_red_killer",          { col: "255,72,56",  r: 96, dur: 2 }],
      ["raveparty_orange_roaster",      { col: "255,138,40", r: 400, dur: 2 }],
      ["raveparty_yellow_slammer",      { col: "255,224,32", r: 192, dur: 2 }],
      ["raveparty_green_stamper",      { col: "88,255,128", r: 192, dur: 2 }],
      ["raveparty_blue_shocker",       { col: "72,214,255", r: 160, dur: 2 }],
      ["raveparty_violet_slugger",     { col: "168,96,255", r: 360, dur: 2 }],
      ["staticheavyarty_plasma",        { col: "150,190,255", r: 88, dur: 2 }],
      ["striderdante_napalm_rockets",       { col: "255,138,40", r: 84, dur: 3 }],
      ["striderdante_napalm_rockets_salvo", { col: "255,138,40", r: 84, dur: 3 }],
      /* EMP lightning strikes: the only lightning guns with a real AoE -
         Venom's stunner (lua aoe 128 -> r 64) and the Scorpion's
         multi-stunner (lua 160 -> r 80); the rest (Knight/Felon/Paladin/
         comm lightninggun, aoe 8) stay plain beams. Cyan = EMP */
      ["spideremp_spider",              { col: "72,214,255", r: 64, dur: 2 }],
      ["striderscorpion_multilightning", { col: "72,214,255", r: 80, dur: 2 }],
      /* the Ogre's Banisher rocket salvo (lua aoe 160 -> r 80): the heavy
         riot tank's splashes deserve their ring */
      ["tankriot_tawf_banisher",        { col: "255,160,90", r: 80, dur: 2 }],
    ];
    const explosions = [];
    /* Zenith meteors are projectiles of the named "Meteor" weapondef; ground
       napalm patches are FIRE only — ZK's lups_napalm classification
       (weapon description / fx; the internal def names carry _napalm_ too,
       which doubles as the fallback for artifacts recorded before the nd
       flag existed). Zeno's slow field (missileslow) is area damage but
       NOT fire — it paints its own lingering purple patch; Placeholder's
       black hole (jumpblackhole) likewise paints dark grey. Firewalker
       shells 64 elmos / 16 s, Inferno warheads 256 / 45 s, Zeno slow
       zones 320 / 30 s, black holes 70 / 13.3 s */
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
        return w && String(w.name || "").toLowerCase().split("_")[0] === "staticantinuke" && p.path.n;
      })
      /* the interceptor's team rides along: the feed line credits the
         antinuke's owner, not the (now very sad) launcher */
      .map((p) => ({ t: p.end, x: p.path.x[p.path.n - 1], z: p.path.z[p.path.n - 1], team: p.team }));
    const intercepts = [];
    for (const p of projectiles) {
      if (!p.mcol || !p.path.n) continue;
      const imp = { t: p.path.t[p.path.n - 1], x: p.path.x[p.path.n - 1], z: p.path.z[p.path.n - 1] };
      const hit = rocketEnds.find((r) => Math.abs(r.t - p.end) <= ICEPT_SPAN_SEC
        && Math.hypot((r.x - imp.x) * wmw, (r.z - imp.z) * wmh) <= ICEPT_RADIUS);
      if (hit) {
        p.intercepted = true;
        /* warhead name key for the feed line (tacnuke/empmissile/.../
           staticnuke), resolved to the display name in the launch-news
           block below */
        const w = wdef.get(p.weaponDefID);
        intercepts.push({ tm: p.end, team: hit.team,
          k: w && w.name ? String(w.name).toLowerCase().split("_")[0] : null });
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
      if (!w || !p.path.n) continue;
      const imp = { t: p.path.t[p.path.n - 1], x: p.path.x[p.path.n - 1], z: p.path.z[p.path.n - 1] };
      const ex = w.name && EXPLOSION_DEFS.find(([n]) => String(w.name).toLowerCase().split("_")[0] === n);
      if (ex && !p.intercepted) {
        explosions.push({ t: imp.t, x: imp.x, y: imp.z, r: (w.aoe ?? 0) > 0 ? w.aoe : ex[1].r, col: ex[1].col, fade: ex[1].fade, dur: ex[1].dur, fx: ex[1].fx === true });
      }
      if (String(w.name) === "Meteor" && (w.aoe ?? 0) > 0) {
        explosions.push({ t: imp.t, x: imp.x, y: imp.z, r: w.aoe, col: "168,96,255", fade: "normal", dur: 8 });
      }
      const ib = IMPACT_BLAST_DEFS.find(([n]) => String(w.name || "").toLowerCase() === n);
      if (ib && !p.intercepted) {
        explosions.push({ t: imp.t, x: imp.x, y: imp.z,
          r: (w.aoe ?? 0) > 0 ? w.aoe : ib[1].r, col: ib[1].col, fade: "normal", dur: ib[1].dur });
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
      /* Placeholder's black hole (jumpblackhole, the Black-Hole artillery
         unit - NOT the Dante): the gravity well is neither fire nor slow,
         it paints as a dark grey lingering circle. Fixed game values
         70 elmos / 13.3 s unless the recording widget provided them */
      if (!p.intercepted && String(w.name || "").toLowerCase().split("_")[0] === "jumpblackhole") {
        napalm.push({
          t: imp.t, x: imp.x, y: imp.z,
          r: (w.adr ?? 0) > 0 ? w.adr : 70,
          dur: (w.adu ?? 0) > 0 ? w.adu : 13.3,
          col: "90,90,90",
        });
      }
      /* DRP's party zone: the disco's Orange Roaster shells leave the
         lingering dance floor (the only rave weapon with area damage,
         400 / 8 s); painted in the weapon's own orange, twinned with its
         400-elmo impact ring above (recorded aoe - the RADIUS, half the
         lua areaOfEffect diameter) */
      if (!p.intercepted && String(w.name || "").toLowerCase() === "raveparty_orange_roaster") {
        napalm.push({
          t: imp.t, x: imp.x, y: imp.z,
          r: (w.adr ?? 0) > 0 ? w.adr : 400,
          dur: (w.adu ?? 0) > 0 ? w.adu : 8,
          col: "255,138,40",
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
      if (!p.mcol || !p.path.n) continue;
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

    /* ---- interception news: the other half of the nuke story (#33) ----
       The feed now reads launch -> intercepted/landed end to end. A volley
       swallowed by antinukes is one line, same 2.5 s grouping as launches;
       the interceptor's team is the one that made the play. */
    intercepts.sort((a, b) => a.tm - b.tm);
    for (let i = 0; i < intercepts.length;) {
      let j = i + 1;
      while (j < intercepts.length && intercepts[j].team === intercepts[i].team &&
             intercepts[j].tm - intercepts[j - 1].tm <= 2.5) j++;
      const cnt = j - i, E = intercepts[i];
      const nm = E.k === "staticnuke" ? "Trinity nuke"
        : LAUNCH_MISSILE_NAMES[E.k] ? LAUNCH_MISSILE_NAMES[E.k] + " missile" : "missile";
      feedData.push({
        tm: E.tm, cls: "intercept",
        txt: (cnt > 1 ? cnt + " × " + nm + "s" : nm) + " intercepted by antinuke!",
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
      "cloakbomb": { r: 176, col: "72,214,255" },   // Imp (cloakbomb_DEATH, lua aoe 352 -> radius 176 per the Skuttle convention); electric-blue blast, not fire
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
    /* units whose EXPLODE weapon leaves lingering ground: the Pyro dies in
       a flame ball - jumpraid's PYRO_DEATH (128 elmos / 13.3 s per game
       data). Explode weapons fire ONCE at death and are LaserCannons
       (never tracked as flights), so the death spot is the only anchor;
       painted as default-orange fire */
    const PATCH_DEATH_DEFS = {
      "jumpraid": { r: 128, dur: 13.3 },   // Pyro — flame ball
    };
    for (const u of units) {
      if (u.died < 0 || u.morph) continue;
      const db = DEATH_BLAST_DEFS[u.def ?? ""] ??
        (/^dyn[a-z]+[1-9]\d*_/.test(u.def ?? "") ? { r: 420 } : null);
      const pd = PATCH_DEATH_DEFS[u.def ?? ""] ?? null;
      if (!db && !pd) continue;
      /* an unfinished nanoframe crumples - it does not go up in its full
         death blast; the table is for complete units */
      if (!u.track.n || u.track.bd[u.track.n - 1] / 255 < 0.99) continue;
      if (db || pd) {
        const lx = u.track.x[u.track.n - 1], ly = u.track.y[u.track.n - 1];
        if (db) {
          explosions.push({ t: u.died, x: lx, y: ly, r: db.r,
            col: db.col ?? "255,150,90", fade: "fast", dur: 0,
            fx: db.fx === true });
        }
        if (pd) {
          napalm.push({ t: u.died, x: lx, y: ly, r: pd.r, dur: pd.dur });
        }
      }
    }

    const links = (artifact.link ? artifact.link.links : []).map((l) => ({
      djinnID: l.djinnID, lampID: l.lampID, team: l.team,
      open: toSec(l.openFrame),
      close: l.closeFrame >= 0 ? toSec(l.closeFrame) : -1,
      lampX: l.lampQX, lampZ: l.lampQZ,
    }));

    /* demo team stats carry the engine's SIM frame (Team.cpp: frame =
       gs->frameNum), so they run on the play clock like the resim
       sections - no pick-phase anchor */
    const ecoPts = [];
    for (const t of (artifact.eco ? artifact.eco.teams : [])) {
      ecoPts.push({ team: t.team, pts: t.stats.map((s) => [toPlay(s.frame), s.metalProduced]) });
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
      /* engagements: concise rows keep the attacker->victim arrow layer
         fed — per ATTACKER, a time-sorted array of {t, v} (victim) rows,
         emitted on victim change or as a 0.6 s keep-alive while the pair
         keeps landing hits; engAt(rows, tm) resolves the current target */
      engagements,
      ENGAGE_TTL,
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

  /** Resolve an attacker's CURRENT target at playback time tm: the latest
   *  engagement row at-or-before tm, when the keep-alive has not expired
   *  (ttl, default 1.2 sim-seconds — the half-life of "still fighting"
   *  between the widget's 0.6 s refreshes). Returns the row {t, v} or
   *  null before the first recorded hit / once the fight went quiet.
   *  Binary search over shape-sorted per-attacker rows — O(log n) per
   *  attacker per frame, no per-frame state. */
  function engAt(rows, tm, ttl) {
    let lo = 0, hi = rows.length - 1, cand = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].t <= tm) { cand = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (cand < 0 || tm - rows[cand].t > ttl) return null;
    return rows[cand];
  }

  /** Sample a unit track at time tm — coordinate + hp + build + cloak state
   *  interpolated between probes. Track points are {t, x, y} with y the map
   *  z-axis; hp/bd/ck step at the segment mid-point. */
  /* Sample a unit's columnar track at time tm (linear between probes for
     position; hp/build/flags/shield read from the NEAR sample, matching the
     object-era behaviour). Returns a fresh small object — short-lived, young-
     generation garbage, which is cheap; the columns are the long-lived data. */
  function trackAt(track, tm) {
    const n = track.n;
    if (!n) return null;
    if (tm <= track.t[0]) return trackSample(track, 0);
    if (tm >= track.t[n - 1]) return trackSample(track, n - 1);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (track.t[mid] <= tm) lo = mid; else hi = mid;
    }
    const f = (tm - track.t[lo]) / (track.t[hi] - track.t[lo] || 1);
    const near = f < 0.5 ? lo : hi;
    const s = trackSample(track, near);
    s.x = track.x[lo] + (track.x[hi] - track.x[lo]) * f;
    s.y = track.y[lo] + (track.y[hi] - track.y[lo]) * f;
    return s;
  }

  /* one track row as the page-facing object (fractions, flag semantics) */
  function trackSample(track, i) {
    const fl = track.fl[i];
    return {
      x: track.x[i],
      y: track.y[i],
      hp: track.hp[i] / 255,
      bd: track.bd[i] / 255,
      ck: (fl & 1) !== 0,
      /* own area-cloak field bits exist only on v3 sections — on older
         artifacts the padding must read as undefined, not false */
      cf: track.v3 ? (fl & 2) !== 0 : undefined,
      cs: track.v3 ? (fl & 4) !== 0 : undefined,
      sh: track.sh[i] === 255 ? undefined : track.sh[i] / 254,
    };
  }

  /** Sample a projectile path at time tm (linear between probes). */
  function pathAt(path, tm) {
    const n = path.n;
    let i;
    if (tm <= path.t[0]) i = 0;
    else if (tm >= path.t[n - 1]) i = n - 1;
    else {
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (path.t[mid] <= tm) lo = mid; else hi = mid;
      }
      const f = (tm - path.t[lo]) / (path.t[hi] - path.t[lo] || 1);
      return {
        x: path.x[lo] + (path.x[hi] - path.x[lo]) * f,
        y: path.y[lo] + (path.y[hi] - path.y[lo]) * f,
        z: path.z[lo] + (path.z[hi] - path.z[lo]) * f,
      };
    }
    return { x: path.x[i], y: path.y[i], z: path.z[i] };
  }

  global.ZkrReplay = {
    parse, artifactToModel, trackAt, pathAt, mapFitRect,
    parseStartboxes, parseStartboxesBlob, setUnitIconBase, iconFor, iconSize, tintIcon, outlineIcon,
    teamColor, hpColor, hslToRgb, damageShade, shieldColor, TEAL16, WARM16,
    EXCLUDED_UNIT_DEFS, unitValueClass,
    commLevelOfDef, commValueOfDef, COMM_MORPH_BASE_COSTS,
    FPS, PROJ_CLASS_NAME, EVNT_KIND_NAME, STARTBOX_FADE_SEC,
    MORPH_PAIR_WINDOW_SEC,
    engAt,
  };
})(typeof window !== "undefined" ? window : globalThis);
