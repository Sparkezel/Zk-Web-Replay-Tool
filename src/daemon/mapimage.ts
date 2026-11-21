/**
 * Map backdrop extraction: reads the minimap that is embedded in every SM2
 * (.smf) map file (1024x1024 DXT1 + 8 sub-mips at header.minimapPtr, see
 * RecoilEngine rts/Map/SMF/SMFFormat.h) and writes a PNG next to the .zkr
 * artifact for the viewer's background.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { deflateSync } from "node:zlib";

const SMF_MAGIC = "spring map file\0";

interface SmfHeader {
  mapX: number;
  mapY: number;
  minimapPtr: number;
}

function readSmfHeader(buf: Buffer): SmfHeader | null {
  // magic[16] + 16 int32 fields (version .. numExtraHeaders) = 80 bytes
  if (buf.length < 80) return null;
  if (buf.subarray(0, 16).toString("latin1") !== SMF_MAGIC) return null;
  const mapX = buf.readInt32LE(24);
  const mapY = buf.readInt32LE(28);
  const minimapPtr = buf.readInt32LE(64);
  if (mapX <= 0 || mapY <= 0 || minimapPtr <= 0 || minimapPtr >= buf.length) return null;
  return { mapX, mapY, minimapPtr };
}

/** Decode a DXT1 block array (w and h multiple of 4) into a w*h RGBA Uint8Array. */
export function decodeDxt1(buf: Buffer, w: number, h: number, out?: Uint8Array): Uint8Array {
  const rgba = out ?? new Uint8Array(w * h * 4);
  const bw = w >> 2, bh = h >> 2;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const off = (by * bw + bx) * 8;
      const c0 = buf.readUInt16LE(off);
      const c1 = buf.readUInt16LE(off + 2);
      const indices = buf.readUInt32LE(off + 4);
      const r0 = ((c0 >> 11) & 31) * 255 / 31, g0 = ((c0 >> 5) & 63) * 255 / 63, b0 = (c0 & 31) * 255 / 31;
      const r1 = ((c1 >> 11) & 31) * 255 / 31, g1 = ((c1 >> 5) & 63) * 255 / 63, b1 = (c1 & 31) * 255 / 31;
      const palette = c0 > c1
        ? [[r0, g0, b0], [r1, g1, b1],
           [(2 * r0 + r1) / 3, (2 * g0 + g1) / 3, (2 * b0 + b1) / 3],
           [(r0 + 2 * r1) / 3, (g0 + 2 * g1) / 3, (b0 + 2 * b1) / 3]]
        : [[r0, g0, b0], [r1, g1, b1],
           [(r0 + r1) / 2, (g0 + g1) / 2, (b0 + b1) / 2],
           [0, 0, 0]];
      for (let p = 0; p < 16; p++) {
        const idx = (indices >> (2 * p)) & 3;
        const px = bx * 4 + (p & 3), py = by * 4 + (p >> 2);
        const o = (py * w + px) * 4;
        rgba[o] = Math.round(palette[idx][0]);
        rgba[o + 1] = Math.round(palette[idx][1]);
        rgba[o + 2] = Math.round(palette[idx][2]);
        rgba[o + 3] = 255;
      }
    }
  }
  return rgba;
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Minimal PNG encoder (truecolor RGB, one uncompressed filter row per line). */
export function encodePng(w: number, h: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const line = y * (1 + w * 3);
    raw[line] = 0;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      raw[line + 1 + x * 3] = rgba[s];
      raw[line + 2 + x * 3] = rgba[s + 1];
      raw[line + 3 + x * 3] = rgba[s + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const MINIMAP_TOP = 1024;
const DXT1_BYTES = (dim: number) => Math.ceil(dim / 4) ** 2 * 8;

/** Normalise for matching: map names and their .smf filenames drift
 *  ("Otago 1.4" ~ "otago_v04.smf"), so compare on letters only — version
 *  digits, separators and underscores are all dropped. */
function smfKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z]+/g, "");
}

/** Common prefix length of two normalised keys (0 when either is empty). */
function keyOverlap(a: string, b: string): number {
  let n = 0;
  const len = Math.min(a.length, b.length);
  while (n < len && a[n] === b[n]) n++;
  return n;
}

/** Where a battle's map data lives: a loose .smf file, or a packed Spring
 *  archive (.sd7 = 7-Zip, .sdz = zip) containing the .smf at some inner path. */
export type MapSourceKind = "smf" | "sd7" | "sdz";
export interface MapSource {
  /** filesystem path of the .smf, or of the archive that contains it */
  path: string;
  kind: MapSourceKind;
  /** normalised-name overlap with the battle's map name (0 = no match) */
  score: number;
  /** length of the normalised archive/smf key (tie-break, not for display) */
  keyLen: number;
}

/**
 * Locate the best map source under the given roots (the staged maps dir):
 * loose .smf files and packed .sd7/.sdz map archives alike — a typical ZK
 * install holds hundreds of archives and few (or zero) loose .smf files.
 * `mapName` (from the startscript, e.g. "Otago 1.4") biases selection: the
 * entry with the highest normalised-name overlap wins; ties prefer a loose
 * .smf (no extraction tool needed) and then the key closest to the map name
 * in length ("Otago 1.4" beats "Otago Redux 1.4" on the same prefix). Still
 * nothing? The first entry found wins, so extraction works without a match.
 */
export function findMapSource(roots: string[], mapName?: string): MapSource | null {
  const want = mapName !== undefined ? smfKey(mapName) : "";
  let best: MapSource | null = null;
  const beats = (c: MapSource): boolean => {
    if (best === null) return true;
    if (c.score !== best.score) return c.score > best.score;
    if ((c.kind === "smf") !== (best.kind === "smf")) return c.kind === "smf";
    if (want.length === 0) return false; // no map name: keep first-found
    // same score, same class: closer key length wins (see doc comment)
    return Math.abs(c.keyLen - want.length) < Math.abs(best.keyLen - want.length);
  };
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const lower = e.name.toLowerCase();
        if (e.isDirectory()) {
          stack.push(path.join(dir, e.name));
          continue;
        }
        const ext = lower.endsWith(".smf") ? ".smf"
          : lower.endsWith(".sd7") ? ".sd7"
          : lower.endsWith(".sdz") ? ".sdz"
          : null;
        if (ext === null) continue;
        const key = smfKey(e.name.slice(0, -ext.length));
        const cand: MapSource = {
          path: path.join(dir, e.name),
          kind: ext.slice(1) as MapSourceKind,
          score: keyOverlap(key, want),
          keyLen: key.length,
        };
        if (beats(cand)) best = cand;
      }
    }
  }
  return best;
}

/**
 * Extract the embedded minimap as a PNG of at most maxDim pixels wide.
 * Returns the written image dimensions, or null when no usable map data.
 */
export function extractMapImageFromBuffer(buf: Buffer, outPngPath: string, maxDim = 512): { w: number; h: number } | null {
  const hdr = readSmfHeader(buf);
  if (hdr === null) return null;
  let offset = hdr.minimapPtr;
  let dim = MINIMAP_TOP;
  while (dim > maxDim && dim > 4) {
    offset += DXT1_BYTES(dim);
    dim >>= 1;
  }
  if (offset + DXT1_BYTES(dim) > buf.length) return null;
  const rgba = decodeDxt1(buf.subarray(offset, offset + DXT1_BYTES(dim)), dim, dim);
  writeFileSync(outPngPath, encodePng(dim, dim, rgba));
  return { w: dim, h: dim };
}

/** Loose-.smf variant of {@link extractMapImageFromBuffer}. */
export function extractMapImage(smfPath: string, outPngPath: string, maxDim = 512): { w: number; h: number } | null {
  return extractMapImageFromBuffer(readFileSync(smfPath), outPngPath, maxDim);
}

/* ------------------------------------------------------------------ */
/* Packed .sd7 (7-Zip) / .sdz (zip) map archives                       */

const SEVENZIP_FALLBACKS = [
  process.env.ZKR_7Z,
  "C:\\Program Files\\7-Zip\\7z.exe",
  "C:\\Program Files (x86)\\7-Zip\\7z.exe",
];

/** Absolute path of a usable 7z binary, or null when none is installed. */
export function findSevenZip(): string | null {
  for (const p of SEVENZIP_FALLBACKS) {
    if (p !== undefined && p !== "" && existsSync(p)) return p;
  }
  // PATH lookup (common on Linux: p7zip/nomacs packages it as `7z`/`7za`)
  const probe = spawnSync("7z", [], { timeout: 5000, windowsHide: true });
  return probe.error === undefined ? "7z" : null;
}

/** List the inner .smf entry paths inside a packed Spring archive. */
export function sevenZipSmfEntries(archivePath: string, bin: string): string[] | null {
  const res = spawnSync(bin, ["l", "-slt", archivePath], { maxBuffer: 16 << 20, windowsHide: true });
  if (res.error !== undefined || res.status !== 0 || res.stdout === undefined) return null;
  return [...res.stdout.toString("utf8").matchAll(/^Path = (.+)$/gm)]
    .map((m) => m[1]!)
    .filter((p) => p.toLowerCase().endsWith(".smf"));
}

/**
 * Extract the minimap from a packed .sd7/.sdz map archive to outPngPath.
 * The inner .smf name often does not match the map's display name at all
 * ("Otago 1.4" ships `maps/lavamountains.smf`), so best name-overlap wins
 * and a lone .smf entry is always taken. Returns the written image
 * dimensions, or null when 7-Zip is unavailable, the archive holds no
 * .smf, or the .smf has no usable minimap.
 */
export function extractMapImageFromArchive(
  archivePath: string,
  outPngPath: string,
  opts: { maxDim?: number; mapName?: string; sevenZip?: string } = {},
): { w: number; h: number } | null {
  const bin = opts.sevenZip ?? findSevenZip();
  if (bin === null) return null;
  const entries = sevenZipSmfEntries(archivePath, bin);
  if (entries === null || entries.length === 0) return null;
  // pick the entry to stream: name-overlap score, then first listed
  const want = opts.mapName !== undefined ? smfKey(opts.mapName) : "";
  let best = entries[0]!;
  let bestScore = -1;
  for (const e of entries) {
    const base = e.replace(/\\/g, "/").split("/").pop()!;
    const score = keyOverlap(smfKey(base.slice(0, -4)), want);
    if (score > bestScore) {
      best = e;
      bestScore = score;
    }
  }
  // stream the single entry to stdout without touching the disk
  const ex = spawnSync(bin, ["e", "-so", archivePath, best], { maxBuffer: 512 << 20, windowsHide: true });
  if (ex.error !== undefined || ex.status !== 0 || ex.stdout === undefined || ex.stdout.length === 0) return null;
  return extractMapImageFromBuffer(ex.stdout, outPngPath, opts.maxDim);
}
