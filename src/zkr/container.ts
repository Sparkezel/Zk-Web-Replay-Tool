/**
 * .zkr v1 container — sectioned binary per docs/REPLAY_LOGGING_SPEC.md.
 *
 * Layout: "ZKR" magic, u8 version=1, then repeated sections:
 *   u32 fourcc | u16 sectionVersion | u8 codec (0=raw, 1=deflate) | u8 reserved
 *   u32 uncompressedSize | u32 compressedSize | payload
 * All little-endian.
 */
import * as zlib from "node:zlib";

// zstd landed in Node 23.8 / 22.15+; guard so older versions load this module
// and simply fall back to deflate.
const zstdCompressSync: ((buf: Uint8Array) => Uint8Array) | null =
  typeof (zlib as Record<string, unknown>).zstdCompressSync === "function"
    ? (zlib as Record<string, unknown>).zstdCompressSync as (buf: Uint8Array) => Uint8Array
    : null;
const zstdDecompressSync: ((buf: Uint8Array) => Uint8Array) | null =
  typeof (zlib as Record<string, unknown>).zstdDecompressSync === "function"
    ? (zlib as Record<string, unknown>).zstdDecompressSync as (buf: Uint8Array) => Uint8Array
    : null;

const deflateSync = zlib.deflateSync;
const inflateSync = zlib.inflateSync;

export const ZKR_VERSION = 1;
export const CODEC_RAW = 0;
export const CODEC_DEFLATE = 1;
export const CODEC_ZSTD = 2;

const hasZstd = typeof zstdCompressSync === "function" && typeof zstdDecompressSync === "function";

/** Best available compression codec for section payloads (zstd preferred). */
export function bestCodec(): typeof CODEC_ZSTD | typeof CODEC_DEFLATE {
  return hasZstd ? CODEC_ZSTD : CODEC_DEFLATE;
}

function compressCodec(payload: Uint8Array, codec: number): { payload: Uint8Array; codec: number } {
  if (codec === CODEC_ZSTD) {
    if (hasZstd) return { payload: zstdCompressSync(payload), codec: CODEC_ZSTD };
    return { payload: deflateSync(payload, { level: 9 }), codec: CODEC_DEFLATE };
  }
  if (codec === CODEC_DEFLATE) return { payload: deflateSync(payload, { level: 9 }), codec: CODEC_DEFLATE };
  return { payload, codec: CODEC_RAW };
}

export const SECTION = {
  META: "META",
  ROSTER: "ROST",
  UNITDEF: "UDEF",
  WEAPONDEF: "WDEF",
  POS: "POS ",
  EVENTS: "EVNT",
  PROJECTILES: "PROJ",
  LINKS: "LINK",
  STARTBOX: "STBX",
  CHAT: "CHAT",
  MAPDRAW: "DRAW",
  MACRO: "MACR",
  ECO: "ECO ",
  PLAYERSTATS: "PSTA",
} as const;

export interface SectionInput {
  id: string;
  version: number;
  payload: Uint8Array;
  codec?: number;
}

export function writeZkr(sections: SectionInput[]): Uint8Array {
  const out: Uint8Array[] = [Uint8Array.of(0x5a, 0x4b, 0x52, ZKR_VERSION)];
  for (const sect of sections) {
    const codec = sect.codec ?? CODEC_DEFLATE;
    const compressed = compressCodec(sect.payload, codec);
    const payload = compressed.payload;
    const id = String(sect.id).padEnd(4, " ").slice(0, 4);
    const head = new DataView(new ArrayBuffer(16));
    head.setUint8(0, id.charCodeAt(0));
    head.setUint8(1, id.charCodeAt(1));
    head.setUint8(2, id.charCodeAt(2));
    head.setUint8(3, id.charCodeAt(3));
    head.setUint16(4, sect.version, true);
    head.setUint8(6, compressed.codec);
    head.setUint8(7, 0);
    head.setUint32(8, sect.payload.byteLength, true);
    head.setUint32(12, payload.byteLength, true);
    out.push(new Uint8Array(head.buffer), payload);
  }
  const total = out.reduce((acc, c) => acc + c.byteLength, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const c of out) {
    buf.set(c, o);
    o += c.byteLength;
  }
  return buf;
}

export interface ZkrSection {
  id: string;
  version: number;
  codec: number;
  payload: Uint8Array;
}

export function readZkr(buf: Uint8Array): ZkrSection[] {
  if (buf.length < 4 || !(buf[0] === 0x5a && buf[1] === 0x4b && buf[2] === 0x52)) {
    throw new Error("not a .zkr file");
  }
  const version = buf[3]!;
  if (version !== ZKR_VERSION) throw new Error(`unsupported .zkr version ${version}`);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const secs: ZkrSection[] = [];
  let pos = 4;
  while (pos < buf.byteLength) {
    if (pos + 16 > buf.byteLength) throw new Error("truncated section header");
    const id = String.fromCharCode(
      buf[pos]!, buf[pos + 1]!, buf[pos + 2]!, buf[pos + 3]! === 32 ? 32 : buf[pos + 3]!,
    );
    const sectVersion = dv.getUint16(pos + 4, true);
    const codec = dv.getUint8(pos + 6);
    const uncompressedSize = dv.getUint32(pos + 8, true);
    const compressedSize = dv.getUint32(pos + 12, true);
    pos += 16;
    if (pos + compressedSize > buf.byteLength) throw new Error(`truncated section ${JSON.stringify(id)}`);
    const stored = buf.subarray(pos, pos + compressedSize);
    pos += compressedSize;
    const payload = codec === CODEC_DEFLATE
      ? inflateSync(stored)
      : codec === CODEC_ZSTD && zstdDecompressSync
        ? zstdDecompressSync(stored)
        : stored;
    if (payload.byteLength !== uncompressedSize) {
      throw new Error(`size mismatch in section ${JSON.stringify(id)}`);
    }
    secs.push({ id, version: sectVersion, codec, payload });
  }
  return secs;
}
