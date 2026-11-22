/**
 * Binary section encoders for resim-derived data (spec §B/§C/§L) and the
 * full `.zkr` packer. Coordinates are quantized across map size to u16
 * (65535 = map edge), delta-encoded per track, per spec §F.
 */
import {
  CODEC_DEFLATE, CODEC_RAW, SECTION,
  writeZkr, type SectionInput,
} from "../zkr/container.js";
import {
  buildChatSection, buildEcoSection, buildMacroSection, buildMapDrawSection,
  buildMetaSection, buildPlayerStatsSection, buildRosterSection,
} from "../zkr/build.js";
import type { ParsedDemo } from "../demo/parse.js";
import { classifyProjectile, presetRecords, type ProjectilePreset } from "./classify.js";
import { LINK_OPEN_SENTINEL, type EvntRecord, type SnapshotData } from "./events.js";

class ByteWriter {
  private buf = new Uint8Array(256);
  private len = 0;
  private ensure(n: number): void {
    if (this.len + n <= this.buf.byteLength) return;
    let cap = this.buf.byteLength;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  private dv(): DataView {
    return new DataView(this.buf.buffer);
  }
  u8(v: number): this {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
    return this;
  }
  u16(v: number): this {
    this.ensure(2);
    this.dv().setUint16(this.len, v & 0xffff, true);
    this.len += 2;
    return this;
  }
  s16(v: number): this {
    this.ensure(2);
    this.dv().setInt16(this.len, v, true);
    this.len += 2;
    return this;
  }
  u32(v: number): this {
    this.ensure(4);
    this.dv().setUint32(this.len, v >>> 0, true);
    this.len += 4;
    return this;
  }
  s32(v: number): this {
    this.ensure(4);
    this.dv().setInt32(this.len, v | 0, true);
    this.len += 4;
    return this;
  }
  bytes(chunk: Uint8Array): this {
    this.ensure(chunk.byteLength);
    this.buf.set(chunk, this.len);
    this.len += chunk.byteLength;
    return this;
  }
  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

const U16_MAX = 65535;

export interface Quantization {
  scale: number;
}

/** Quantize a world coordinate to 0..65535 across `mapSize` elmos. */
export function quantize(v: number, mapSize: number): number {
  if (mapSize <= 0) return 0;
  return Math.max(0, Math.min(U16_MAX, Math.round((v / mapSize) * U16_MAX)));
}

export function quantizationOf(snap: SnapshotData): Quantization {
  return { scale: snap.meta.mapW && snap.meta.mapW > 0 ? snap.meta.mapW : 0 };
}

/**
 * `POS ` v1 — sampled unit positions.
 *
 *   u32 numUnits
 *   repeat: u32 unitID, u16 defID, u32 firstFrame, u16 sampleCount
 *           u16 originX, u16 originZ
 *           repeat sample: s16 dX, s16 dZ, u8 hpFrac, u8 buildFrac
 *
 * `POS ` v2 — v1 plus real sample timing (the widget probes every 6th frame;
 *           v1 decoders wrongly assumed one sample per frame, compressing unit
 *           motion to 1/6 of its life) and the cloak bit:
 *
 *           repeat sample: s16 dX, s16 dZ, s16 frameDelta, u8 hpFrac,
 *                          u8 buildFrac, u8 flags (bit0 = cloaked)
 *
 * `POS ` v3 — v2 plus the area-cloak field bits in the flags byte and a
 *           shield charge byte (all three: shields/area cloak render):
 *
 *           repeat sample: s16 dX, s16 dZ, s16 frameDelta, u8 hpFrac,
 *                          u8 buildFrac,
 *                          u8 flags (bit0 = cloaked,
 *                                    bit1 = own area-cloak field active,
 *                                    bit2 = own area-cloak field stalled),
 *                          u8 shieldFrac (255 = no shield/unknown,
 *                                         0..254 = charge × 254)
 *
 *           v2 decoders must NOT read bit1/bit2 as field bits: v2 artifacts
 *           predate them and their padding reads as 0.
 */
export function encodePos(snap: SnapshotData): Uint8Array {
  const mapW = snap.meta.mapW ?? 0;
  const mapH = snap.meta.mapH ?? mapW;
  const w = new ByteWriter();
  const tracks = [...snap.units.values()].filter((u) => u.samples.length > 0)
    .sort((a, b) => a.unitID - b.unitID);
  w.u32(tracks.length);
  for (const t of tracks) {
    const samples = t.samples;
    const originX = quantize(samples[0]!.x, mapW);
    const originZ = quantize(samples[0]!.z, mapH);
    w.u32(t.unitID).u16(Math.max(0, t.defID) & 0xffff).u32(samples[0]!.frame).u16(samples.length);
    w.u16(originX).u16(originZ);
    let prevX = originX;
    let prevZ = originZ;
    let prevFrame = samples[0]!.frame;
    for (const s of samples) {
      const qx = quantize(s.x, mapW);
      const qz = quantize(s.z, mapH);
      w.s16(qx - prevX).s16(qz - prevZ);
      // frames since the previous sample (0 for the first): keeps probe
      // cadence lossless instead of assuming one sample per frame
      w.s16(s.frame - prevFrame);
      // hp/build arrive as 0..255 from the event model (samples carry raw 0..1 fractions);
      // unknown (undefined) packs as 255 = full hp / finished build
      w.u8(Math.max(0, Math.min(255, Math.round(s.hp ?? 255))))
        .u8(Math.max(0, Math.min(255, Math.round(s.build ?? 255))));
      // flags: bit0 = cloaked now (own/ally-field/personal), bit1 = this
      // unit's own area-cloak field active, bit2 = field stalled/unpowered
      w.u8((s.cloaked ? 1 : 0) | (s.cloakField ? 2 : 0) | (s.cloakStalled ? 4 : 0));
      // shield charge: 255 = no shield/unknown, else 0..254 = charge x 254
      w.u8(s.shield === undefined ? 255
        : Math.max(0, Math.min(254, Math.round(s.shield * 254))));
      prevX = qx;
      prevZ = qz;
      prevFrame = s.frame;
    }
  }
  return w.finish();
}

const EVNT_KIND: Record<string, number> = { spawn: 0, death: 1, finished: 2, transfer: 3, gameover: 4, wreck: 5, unwreck: 6 };

/** `EVNT` — unit lifecycle + wreck-feature events.
 *
 *   u32 numRecords
 *   repeat: u8 kind, u32 frame, s32 unitID, s32 int1, s32 int2, s32 int3
 *   (spawn: defID, team, builderID — death: killerUnit, killerTeam, weaponDef
 *    gameover: unitID -1, int1 first winner allyteam, int2 winner count
 *    wreck: unitID = featureID, int1 = reclaimable metal, int2/int3 = x/z elmos
 *    unwreck: unitID = featureID, int1..3 = -1)
 */
export function encodeEvents(snap: SnapshotData): Uint8Array {
  const w = new ByteWriter();
  const rows: EvntRecord[] = [...snap.events];
  for (const g of snap.gameOvers) {
    rows.push({ kind: "gameover", frame: g.frame, unitID: -1, int1: g.winners[0] ?? -1, int2: g.winners.length, int3: -1 });
  }
  rows.sort((a, b) => a.frame - b.frame);
  w.u32(rows.length);
  for (const e of rows) {
    w.u8(EVNT_KIND[e.kind] ?? 0).u32(e.frame).s32(e.unitID)
      .s32(e.int1).s32(e.int2).s32(e.int3);
  }
  return w.finish();
}

/**
 * `PROJ` v1 — projectile trajectories (spec §C policy applied at pack time).
 *
 *   u32 numProjectiles
 *   repeat: u32 proID, u32 weaponDefID, u8 class, u16 ownerTeam,
 *           u32 firstFrame, u16 sampleCount
 *           u16 originX, u16 originY, u16 originZ
 *           repeat sample: s16 dX, s16 dZ, s16 absQY
 *
 * `PROJ` v2 — v1 plus real sample timing (see POS v2):
 *           repeat sample: s16 dX, s16 dZ, s16 absQY, s16 frameDelta
 */
export function encodeProjectiles(snap: SnapshotData, preset: ProjectilePreset = "heavy"): Uint8Array {
  const mapW = snap.meta.mapW ?? 0;
  const mapH = snap.meta.mapH ?? mapW;
  const w = new ByteWriter();
  const kept = [...snap.projectiles.values(), ...(snap.closedProjectiles ?? [])]
    .filter((p) => presetRecords(preset, classifyProjectile(snap.weaponDefs.get(p.weaponDefID) ?? { defID: p.weaponDefID })))
    .filter((p) => p.samples.length > 0)
    .sort((a, b) => a.proID - b.proID || a.samples[0]!.frame - b.samples[0]!.frame);
  w.u32(kept.length);
  for (const p of kept) {
    const cls = classifyProjectile(snap.weaponDefs.get(p.weaponDefID) ?? { defID: p.weaponDefID });
    const s0 = p.samples[0]!;
    const ox = quantize(s0.x, mapW);
    const oy = quantize(s0.y, mapH);
    const oz = quantize(s0.z, mapH);
    w.u32(p.proID).u32(Math.max(0, p.weaponDefID) >>> 0).u8(cls)
      .u16((Math.max(-1, p.ownerTeam) + 1) & 0xffff)
      .u32(s0.frame).u16(p.samples.length);
    w.u16(ox).u16(oy).u16(oz);
    let prevX = ox;
    let prevZ = oz;
    let prevFrame = s0.frame;
    for (const s of p.samples) {
      const qx = quantize(s.x, mapW);
      const qz = quantize(s.z, mapH);
      w.s16(qx - prevX).s16(qz - prevZ).s16(quantize(s.y, mapH));
      w.s16(s.frame - prevFrame);
      prevX = qx;
      prevZ = qz;
      prevFrame = s.frame;
    }
  }
  return w.finish();
}

/**
 * `LINK` v1 — Djinn ⇄ Lamp links (spec §L).
 *
 *   u32 numLinks
 *   repeat: u32 djinnID, u32 lampID, u32 team, u32 openFrame, u32 closeFrame,
 *           u16 lampQX, u16 lampQZ
 *   closeFrame 0xffffffff while the link is open.
 */
export function encodeLinks(snap: SnapshotData): Uint8Array {
  const mapW = snap.meta.mapW ?? 0;
  const mapH = snap.meta.mapH ?? mapW;
  const w = new ByteWriter();
  const links = [...snap.links.values()].sort((a, b) => a.lampID - b.lampID);
  w.u32(links.length);
  for (const l of links) {
    w.u32(l.djinnID).u32(l.lampID).u32(Math.max(0, l.team) >>> 0)
      .u32(Math.max(0, l.openFrame) >>> 0)
      .u32(l.closeFrame === undefined ? LINK_OPEN_SENTINEL : Math.max(0, l.closeFrame) >>> 0)
      .u16(quantize(l.lampX ?? 0, mapW)).u16(quantize(l.lampZ ?? 0, mapH));
  }
  return w.finish();
}

function jsonSection(value: unknown): Uint8Array {
  return utf8(JSON.stringify(value));
}

/** META payload with the map's elmo dims patched in from the widget snapshot
 *  (the demo header only carries the map's name — dims ship as null there;
 *  the viewer needs the size to scale cloak-field circles). */
function metaWithDims(demo: ParsedDemo, snap: SnapshotData): Uint8Array {
  const payload = buildMetaSection(demo);
  const mapW = snap.meta.mapW ?? 0;
  const mapH = snap.meta.mapH ?? 0;
  if (mapW <= 0 || mapH <= 0) return payload;
  try {
    const meta = JSON.parse(new TextDecoder().decode(payload)) as { map: { dims: [number, number] | null } };
    meta.map.dims = [mapW, mapH];
    return utf8(JSON.stringify(meta));
  } catch {
    return payload;
  }
}

/**
 * Startboxes as loaded by the engine (from the map's mapconfig/map_startboxes.lua
 * or the game's LuaRules/Configs/StartBoxes/<map>.lua, read via the start_boxes
 * gadget's rules params). Polygons are already normalized 0..1 by the widget.
 */
function encodeStartboxes(snap: SnapshotData): Uint8Array | null {
  const sb = snap.startboxes;
  if (!sb || (sb.boxes.size === 0 && sb.allyBox.length === 0)) return null;
  return jsonSection({
    schema: 1,
    boxes: [...sb.boxes.entries()].map(([id, polys]) => ({ id, polys })),
    ally: sb.allyBox,
  });
}

function encodeUnitDefs(snap: SnapshotData): Uint8Array {
  const rows = [...snap.unitDefs.values()]
    .sort((a, b) => a.defID - b.defID)
    .map((d) => [d.defID, d.name, d.metalCost ?? -1, d.health ?? -1, d.canMove === undefined ? -1 : d.canMove ? 1 : 0, d.iconType ?? "", d.humanName ?? "", d.cloakRadius ?? -1, d.shieldRadius ?? -1, d.shieldPower ?? -1]);
  return jsonSection({ schema: 1, units: rows });
}

function encodeWeaponDefs(snap: SnapshotData): Uint8Array {
  const rows = [...snap.weaponDefs.values()]
    .map((d) => {
      const cls = classifyProjectile(d);
      return {
        id: d.defID, name: d.name, type: d.type, range: d.range ?? -1,
        class: cls, className: PROJ_CLASS_NAME[cls] ?? "dropped",
      };
    })
    .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  return jsonSection({ schema: 1, weapons: rows });
}

const PROJ_CLASS_NAME: Record<number, string> = {
  0: "dropped", 1: "beam", 2: "artillery", 3: "nuke", 4: "missile", 5: "interceptor",
};

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export interface PackOptions {
  /** section codec override (default CODEC_DEFLATE for browser compat) */
  codec?: number;
  /** position sample cadence multiplier (keep every Nth probe, keep last) */
  posRate?: number;
  /** projectile recording preset — spec §C */
  projectiles?: ProjectilePreset;
  /** M1 cheap-parse demo data; when absent only resim sections are emitted */
  demo?: ParsedDemo;
}

/** Downsample unit sample lists by `rate`, always keeping the last sample. */
function downsample<T>(rows: T[], rate: number): T[] {
  const n = Math.max(1, Math.floor(rate));
  if (n === 1 || rows.length <= 2) return rows;
  const keep: T[] = [];
  for (let i = 0; i < rows.length - 1; i += n) keep.push(rows[i]!);
  keep.push(rows[rows.length - 1]!);
  return keep;
}

/**
 * Build the complete `.zkr` artifact: META/ROST/UDEF/WDEF/POS/EVNT/PROJ/LINK
 * (+ CHAT/DRAW/MACR/ECO/PSTA when M1 demo data is available), per spec §0.
 */
export function buildZkrFromResim(snap: SnapshotData, opts: PackOptions = {}): Uint8Array {
  // viewer artifacts default to deflate: browsers lack DecompressionStream('zstd')
  const codec = opts.codec ?? CODEC_DEFLATE;
  const posRate = opts.posRate ?? 1;
  const posSnap: SnapshotData = posRate > 1
    ? { ...snap, units: new Map([...snap.units.values()].map((u) => [u.unitID, { ...u, samples: downsample(u.samples, posRate) }])) }
    : snap;
  const secs: SectionInput[] = [];
  if (opts.demo) {
    secs.push(
      // META: the demo header knows the map name but not its elmo size; the
      // widget does (meta w/h) — patch the dims in so the viewer can scale
      // cloak-field circles against the real map dimensions
      { id: SECTION.META, version: 1, payload: metaWithDims(opts.demo, snap), codec },
      { id: SECTION.ROSTER, version: 1, payload: buildRosterSection(opts.demo), codec },
    );
  }
  secs.push(
    { id: SECTION.UNITDEF, version: 3, payload: encodeUnitDefs(snap), codec },
    { id: SECTION.WEAPONDEF, version: 1, payload: encodeWeaponDefs(snap), codec },
    { id: SECTION.POS, version: 3, payload: encodePos(posSnap), codec },
    { id: SECTION.EVENTS, version: 1, payload: encodeEvents(snap), codec },
    { id: SECTION.PROJECTILES, version: 2, payload: encodeProjectiles(posSnap, opts.projectiles ?? "heavy"), codec },
    { id: SECTION.LINKS, version: 1, payload: encodeLinks(snap), codec },
  );
  const startboxPayload = encodeStartboxes(snap);
  if (startboxPayload) {
    secs.splice(
      1,
      0,
      { id: SECTION.STARTBOX, version: 1, payload: startboxPayload, codec },
    );
  }
  if (opts.demo) {
    secs.push(
      { id: SECTION.CHAT, version: 1, payload: buildChatSection(opts.demo), codec },
      { id: SECTION.MAPDRAW, version: 1, payload: buildMapDrawSection(opts.demo), codec },
      { id: SECTION.MACRO, version: 1, payload: buildMacroSection(opts.demo), codec },
      { id: SECTION.ECO, version: 1, payload: buildEcoSection(opts.demo), codec },
      { id: SECTION.PLAYERSTATS, version: 1, payload: buildPlayerStatsSection(opts.demo), codec },
    );
  }
  return writeZkr(secs);
}
