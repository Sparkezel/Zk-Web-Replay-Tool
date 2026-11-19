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
    for (const s of samples) {
      const qx = quantize(s.x, mapW);
      const qz = quantize(s.z, mapH);
      w.s16(qx - prevX).s16(qz - prevZ);
      w.u8(Math.round((s.hp ?? 1) * 255)).u8(Math.round((s.build ?? 1) * 255));
      prevX = qx;
      prevZ = qz;
    }
  }
  return w.finish();
}

const EVNT_KIND: Record<string, number> = { spawn: 0, death: 1, finished: 2, transfer: 3, gameover: 4 };

/**
 * `EVNT` v1 — unit lifecycle events.
 *
 *   u32 numRecords
 *   repeat: u8 kind, u32 frame, s32 unitID, s32 int1, s32 int2, s32 int3
 *   (spawn: defID, team, builderID — death: killerUnit, killerTeam, weaponDef
 *    gameover: unitID -1, int1 first winner allyteam, int2 winner count)
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
 */
export function encodeProjectiles(snap: SnapshotData, preset: ProjectilePreset = "heavy"): Uint8Array {
  const mapW = snap.meta.mapW ?? 0;
  const mapH = snap.meta.mapH ?? mapW;
  const w = new ByteWriter();
  const kept = [...snap.projectiles.values()]
    .filter((p) => presetRecords(preset, classifyProjectile(snap.weaponDefs.get(p.weaponDefID) ?? { defID: p.weaponDefID })))
    .filter((p) => p.samples.length > 0)
    .sort((a, b) => a.proID - b.proID);
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
    for (const s of p.samples) {
      const qx = quantize(s.x, mapW);
      const qz = quantize(s.z, mapH);
      w.s16(qx - prevX).s16(qz - prevZ).s16(quantize(s.y, mapH));
      prevX = qx;
      prevZ = qz;
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

function encodeUnitDefs(snap: SnapshotData): Uint8Array {
  const rows = [...snap.unitDefs.values()]
    .sort((a, b) => a.defID - b.defID)
    .map((d) => [d.defID, d.name, d.metalCost ?? -1, d.health ?? -1]);
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
      { id: SECTION.META, version: 1, payload: buildMetaSection(opts.demo), codec },
      { id: SECTION.ROSTER, version: 1, payload: buildRosterSection(opts.demo), codec },
    );
  }
  secs.push(
    { id: SECTION.UNITDEF, version: 1, payload: encodeUnitDefs(snap), codec },
    { id: SECTION.WEAPONDEF, version: 1, payload: encodeWeaponDefs(snap), codec },
    { id: SECTION.POS, version: 1, payload: encodePos(posSnap), codec },
    { id: SECTION.EVENTS, version: 1, payload: encodeEvents(snap), codec },
    { id: SECTION.PROJECTILES, version: 1, payload: encodeProjectiles(posSnap, opts.projectiles ?? "heavy"), codec },
    { id: SECTION.LINKS, version: 1, payload: encodeLinks(snap), codec },
  );
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
