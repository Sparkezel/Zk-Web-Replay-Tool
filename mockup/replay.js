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

  async function inflateSection(codec, payload) {
    if (codec === 0) return payload;
    if (codec !== 1) throw new Error("section codec " + codec + " is not supported in the browser; pack viewer artifacts with deflate");
    const ds = new DecompressionStream("deflate");
    const stream = new Blob([payload]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function decodePos(dv, u8) {
    const p = { units: [], maxFrame: 0 };
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
      for (let k = 0; k < sampleCount; k++) {
        x += dv.getInt16(o, true) / 65535; o += 2;
        z += dv.getInt16(o, true) / 65535; o += 2;
        const hp = u8[o] / 255; o += 1;
        const build = u8[o] / 255; o += 1;
        samples.push({ frame: firstFrame + k, x, z, hp, build });
      }
      p.units.push({ unitID, defID, firstFrame, samples });
      if (firstFrame + sampleCount > p.maxFrame) p.maxFrame = firstFrame + sampleCount;
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

  function decodeProj(dv, u8) {
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
      for (let k = 0; k < sampleCount; k++) {
        x += dv.getInt16(o, true) / 65535; o += 2;
        z += dv.getInt16(o, true) / 65535; o += 2;
        const y = dv.getInt16(o, true) / 65535; o += 2;
        samples.push({ frame: startFrame + k + 1, x, z, y });
      }
      p.paths.push({ proID, weaponDefID, cls, team: ownerTeam, startFrame, samples });
      if (samples[samples.length - 1].frame > p.maxFrame) p.maxFrame = samples[samples.length - 1].frame;
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

    return {
      containerVersion: u8[3],
      sections,
      meta: json("META"),
      roster: json("ROST"),
      unitDefs: json("UDEF"),
      weaponDefs: json("WDEF"),
      chat: json("CHAT"),
      macro: json("MACR"),
      eco: json("ECO"),
      psta: json("PSTA"),
      pos: raw["POS"] ? decodePos(new DataView(raw["POS"].buffer, raw["POS"].byteOffset, raw["POS"].byteLength), raw["POS"]) : null,
      evnt: raw["EVNT"] ? decodeEvnt(new DataView(raw["EVNT"].buffer, raw["EVNT"].byteOffset, raw["EVNT"].byteLength), raw["EVNT"]) : null,
      proj: raw["PROJ"] ? decodeProj(new DataView(raw["PROJ"].buffer, raw["PROJ"].byteOffset, raw["PROJ"].byteLength), raw["PROJ"]) : null,
      link: raw["LINK"] ? decodeLink(new DataView(raw["LINK"].buffer, raw["LINK"].byteOffset, raw["LINK"].byteLength), raw["LINK"]) : null,
    };
  }

  /**
   * Render model shared by the mockup page: unit tracks, projectile paths,
   * event feed, economy series and the victory state, all in sim-seconds
   * with [0..1] map-space coordinates.
   */
  function artifactToModel(artifact) {
    const toSec = (f) => f / FPS;

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

    const udef = new Map();
    for (const row of (artifact.unitDefs ? artifact.unitDefs.units : [])) udef.set(row[0], { name: row[1], metalCost: row[2], health: row[3] });
    const wdef = new Map();
    for (const w of (artifact.weaponDefs ? artifact.weaponDefs.weapons : [])) wdef.set(w.id, w);

    const feedData = [];
    for (const r of (artifact.evnt ? artifact.evnt.records : [])) {
      if (r.kind !== "death") continue;
      feedData.push({
        tm: toSec(r.frame), cls: "death",
        txt: "Unit #" + r.unitID + " destroyed" +
             (r.int1 >= 0 ? " — killed by unit #" + r.int1 : "") +
             (r.int2 >= 0 ? " (Team " + (r.int2 + 1) + ")" : ""),
      });
    }
    feedData.sort((a, b) => a.tm - b.tm);

    const units = (artifact.pos ? artifact.pos.units : []).map((u) => ({
      id: u.unitID, defID: u.defID,
      team: teamByUnit.has(u.unitID) ? teamByUnit.get(u.unitID) : 0,
      metalCost: udef.has(u.defID) ? (udef.get(u.defID).metalCost ?? -1) : -1,
      born: toSec(u.firstFrame),
      died: deathByUnit.has(u.unitID) ? toSec(deathByUnit.get(u.unitID)) : -1,
      track: u.samples.map((s) => ({ t: toSec(s.frame), x: s.x, y: s.z, hp: s.hp })),
    }));

    const projectiles = (artifact.proj ? artifact.proj.paths : []).map((p) => ({
      proID: p.proID, cls: p.cls, clsName: PROJ_CLASS_NAME[p.cls] ?? "dropped",
      weaponDefID: p.weaponDefID, team: p.team,
      born: toSec(p.startFrame),
      end: toSec(p.samples[p.samples.length - 1].frame),
      path: p.samples.map((s) => ({ t: toSec(s.frame), x: s.x, y: s.y, z: s.z })),
    }));

    const links = (artifact.link ? artifact.link.links : []).map((l) => ({
      djinnID: l.djinnID, lampID: l.lampID, team: l.team,
      open: toSec(l.openFrame),
      close: l.closeFrame >= 0 ? toSec(l.closeFrame) : -1,
      lampX: l.lampQX, lampZ: l.lampQZ,
    }));

    const ecoPts = [];
    for (const t of (artifact.eco ? artifact.eco.teams : [])) {
      ecoPts.push({ team: t.team, pts: t.stats.map((s) => [toSec(s.frame), s.metalProduced]) });
    }

    const posEnd = artifact.pos ? artifact.pos.maxFrame : 0;
    const projEnd = artifact.proj ? artifact.proj.maxFrame : 0;
    const linkEnd = artifact.link ? artifact.link.maxFrame : 0;
    const endTime = toSec(Math.max(endFrame, posEnd, projEnd, linkEnd));
    const metaEnd = artifact.meta && artifact.meta.gameTime ? artifact.meta.gameTime : 0;

    return {
      fps: FPS,
      hasUnits: units.length > 0,
      units, projectiles, links, ecoPts, feedData,
      winner,
      END: Math.max(endTime, metaEnd),
      mapName: artifact.meta ? artifact.meta.map.name : "",
      gameVersion: artifact.meta ? artifact.meta.gameVersion : "",
      engine: artifact.meta ? artifact.meta.engine : "",
      unitNames: udef,
      weaponNames: wdef,
    };
  }

  /** Sample a unit track at time tm — coordinate + hp between probes.
   *  Track points are {t, x, y} with y the map z-axis. */
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
    return {
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      hp: f < 0.5 ? a.hp : b.hp,
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

  global.ZkrReplay = { parse, artifactToModel, trackAt, pathAt, FPS, PROJ_CLASS_NAME, EVNT_KIND_NAME };
})(typeof window !== "undefined" ? window : globalThis);
