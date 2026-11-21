/**
 * Map backdrop extraction tests — DXT1 minimap decoding (SMF-embedded), the
 * minimal PNG encoder roundtrip, and the .smf locator.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { decodeDxt1, encodePng, extractMapImage, extractMapImageFromArchive, findMapSource, findSevenZip } from "../dist/index.js";

test("DXT1 decoder expands a solid block and respects the 4-colour palette", () => {
  const c0 = 0, c1 = 0xffff;             // c0 > c1? no: 0 < 65535 -> 4-colour mode with lerp
  const block = Buffer.alloc(8);
  block.writeUInt16LE(c0, 0);
  block.writeUInt16LE(c1, 2);
  block.writeUInt32LE((0 << 0) | (1 << 2) | (2 << 4) | (3 << 6), 4);
  const rgba = decodeDxt1(block, 4, 4);
  // c0=black, c1=white, c0<c1 so palette = [black, white, 50% grey, transparent-black]
  assert.deepEqual([...rgba.subarray(0, 3)], [0, 0, 0]);
  assert.deepEqual([...rgba.subarray(4, 7)], [255, 255, 255]);
  assert.deepEqual([...rgba.subarray(8, 11)], [128, 128, 128]);
  assert.equal(rgba[3], 255);
});

test("PNG encoder writes a decodable truecolor image", () => {
  const w = 3, h = 2;
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
                               10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255]);
  const png = encodePng(w, h, rgba);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), w);   // IHDR width
  assert.equal(png.readUInt32BE(20), h);   // IHDR height
  assert.equal(png[24], 8);                // bit depth
  assert.equal(png[25], 2);                // colour type RGB
  const idatRaw = inflateSync(png.subarray(8 + 25 + 8, png.length - 12));  // IDAT payload
  assert.equal(idatRaw.length, h * (1 + w * 3));
  assert.deepEqual([...idatRaw.subarray(1, 4)], [255, 0, 0]);
});

/** Build a minimal .smf: header + 1024/512/256 px DXT1 minimap mip chain. */
function syntheticSmf(topLeftColor: number, lastBlockColor: number): Buffer {
  const mips = [1024, 512, 256];
  const parts: Buffer[] = [];
  for (const dim of mips) {
    const blockData = Buffer.alloc((dim / 4) ** 2 * 8);
    blockData.writeUInt16LE(topLeftColor, 0);
    blockData.writeUInt16LE(topLeftColor, 2);
    const last = (dim / 4) ** 2 - 1;                 // bottom-right block
    blockData.writeUInt16LE(lastBlockColor, last * 8);
    blockData.writeUInt16LE(lastBlockColor, last * 8 + 2);
    parts.push(blockData);
  }
  const minimap = Buffer.concat(parts);
  const header = Buffer.alloc(80);   // magic[16] + 16 int32s
  header.write("spring map file\0", 0, 16, "latin1");
  header.writeInt32LE(1, 16);      // version
  header.writeInt32LE(42, 20);     // mapid
  header.writeInt32LE(8192, 24);   // mapx
  header.writeInt32LE(8192, 28);   // mapy
  header.writeInt32LE(8, 32);      // squareSize
  header.writeInt32LE(8, 36);      // texelPerSquare
  header.writeInt32LE(32, 40);     // tilesize
  header.writeFloatLE(0, 44);      // minHeight
  header.writeFloatLE(300, 48);    // maxHeight
  header.writeInt32LE(0, 52);      // heightmapPtr
  header.writeInt32LE(80, 64);     // minimapPtr -> right after header
  header.writeInt32LE(0, 76);      // numExtraHeaders
  return Buffer.concat([header, minimap]);
}

test("extractMapImage walks the mip chain and writes the requested size", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zkr-map-"));
  const smf = path.join(dir, "Otago 1.4.smf");
  writeFileSync(smf, syntheticSmf(0xf800, 0x001f));  // red first block, blue last
  const out = path.join(dir, "map.png");
  const dims = extractMapImage(smf, out, 256);
  assert.ok(dims);
  assert.equal(dims.w, 256);
  assert.equal(dims.h, 256);
  assert.ok(existsSync(out));

  // corner pixels: first block red, last block blue (RGB565 -> 8 bit)
  const png = readFileSync(out);
  const ihdrLen = png.readUInt32BE(8);       // IHDR data length (13)
  let o = 8 + 12 + ihdrLen;                  // sig + len+type+ihdr+crc -> at IDAT len field
  const idatLen = png.readUInt32BE(o);
  const raw = inflateSync(png.subarray(o + 8, o + 8 + idatLen));
  const row = 1 + 256 * 3;
  assert.deepEqual([...raw.subarray(1, 4)], [255, 0, 0]);                       // top-left
  const lastBlockY = 254 * row + 1 + 254 * 3;                                   // pixel (254,254) = last block
  assert.deepEqual([...raw.subarray(lastBlockY, lastBlockY + 3)], [0, 0, 255]); // bottom-right
});

test("findMapSource locates the first .smf in nested roots", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zkr-find-"));
  const deep = path.join(dir, "maps", "sub");
  mkdirSync(deep, { recursive: true });
  assert.equal(findMapSource([path.join(dir, "missing"), dir]), null);
  writeFileSync(path.join(deep, "deadsea.smf"), Buffer.alloc(0));
  const found = findMapSource([path.join(dir, "missing"), dir]);
  assert.ok(found);
  assert.ok(found.path.endsWith("deadsea.smf"));
  assert.equal(found.kind, "smf");
});

test("findMapSource prefers the .smf matching the battle's map name", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zkr-mapname-"));
  const maps = path.join(dir, "maps");
  mkdirSync(maps, { recursive: true });
  // first-in-directory-order must NOT win when it isn't the battle map
  writeFileSync(path.join(maps, "vittra v3.smf"), Buffer.alloc(0));
  const deep = path.join(maps, "Otago 1.4");
  mkdirSync(deep, { recursive: true });
  writeFileSync(path.join(deep, "otago_v04.smf"), Buffer.alloc(0));
  const found = findMapSource([maps], "Otago 1.4");
  assert.ok(found, "battle map must be found");
  assert.ok(found.path.endsWith("otago_v04.smf"), `got ${found.path}`);
  // no match: fall back to the first .smf so extraction still works
  const fb = findMapSource([maps], "Shielded Canyon");
  assert.ok(fb);
  assert.equal(fb.kind, "smf");
});

test("findMapSource matches a packed .sd7 when no loose .smf exists (Otago/Vittra regression)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zkr-archive-"));
  const maps = path.join(dir, "maps");
  mkdirSync(path.join(maps, "vittra3", "maps"), { recursive: true });
  // exactly the on-disk situation that shipped Vittra in place of Otago:
  // an unrelated loose .smf, and the battle's map only as a packed archive
  writeFileSync(path.join(maps, "vittra3", "maps", "Vittra3.smf"), Buffer.alloc(0));
  writeFileSync(path.join(maps, "otago_1.4.sd7"), Buffer.alloc(0));
  const found = findMapSource([maps], "Otago 1.4");
  assert.ok(found, "packed battle map must be found");
  assert.equal(found.kind, "sd7");
  assert.ok(found.path.endsWith("otago_1.4.sd7"), `got ${found.path}`);
  assert.ok(found.score > 0, "the archive must win by name overlap, not fallback");
});

test("findMapSource prefers the exact-named archive over a same-prefix variant", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zkr-variant-"));
  const maps = path.join(dir, "maps");
  mkdirSync(maps, { recursive: true });
  // the real install situation: both score 5 on "otago"; the closer-length
  // key ("otago" over "otagoredux") must win, else Otago Redux is extracted
  writeFileSync(path.join(maps, "Otago Redux 1.4.sd7"), Buffer.alloc(0));
  writeFileSync(path.join(maps, "otago_1.4.sd7"), Buffer.alloc(0));
  const found = findMapSource([maps], "Otago 1.4");
  assert.ok(found);
  assert.ok(found.path.endsWith("otago_1.4.sd7"), `got ${found.path}`);
});

test("findMapSource prefers a loose .smf over an equally-named archive", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zkr-loose-"));
  const maps = path.join(dir, "maps");
  mkdirSync(maps, { recursive: true });
  writeFileSync(path.join(maps, "coastal_v2.sd7"), Buffer.alloc(0));
  writeFileSync(path.join(maps, "coastal_v2.smf"), Buffer.alloc(0));
  const found = findMapSource([maps], "Coastal V2");
  assert.ok(found);
  assert.equal(found.kind, "smf", "a loose .smf needs no extraction tool");
});

test("extractMapImage rejects non-SMF input", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zkr-bad-"));
  const f = path.join(dir, "bad.smf");
  writeFileSync(f, "not a map at all");
  assert.equal(extractMapImage(f, path.join(dir, "x.png")), null);
});

test("extractMapImageFromArchive returns null when the 7z binary is missing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zkr-no7z-"));
  writeFileSync(path.join(dir, "otago_1.4.sd7"), Buffer.alloc(0));
  const dims = extractMapImageFromArchive(
    path.join(dir, "otago_1.4.sd7"),
    path.join(dir, "map.png"),
    { sevenZip: path.join(dir, "definitely-missing-7z.exe") },
  );
  assert.equal(dims, null);
});

test("extractMapImageFromArchive extracts from a packed .sd7/.sdz (needs 7-Zip)", (t) => {
  const bin = findSevenZip();
  if (bin === null) return t.skip("7-Zip not installed in this environment");

  const dir = mkdtempSync(path.join(tmpdir(), "zkr-sd7-"));
  writeFileSync(path.join(dir, "sidetest.smf"), syntheticSmf(0xf800, 0x001f));
  const run = (args: string[]) => {
    const r = spawnSync(bin, args, { cwd: dir, windowsHide: true });
    assert.equal(r.status, 0, `7z ${args.join(" ")} failed`);
  };
  run(["a", "-t7z", "packed.sd7", "sidetest.smf"]);
  run(["a", "-tzip", "packed.sdz", "sidetest.smf"]);

  for (const archive of ["packed.sd7", "packed.sdz"]) {
    const out = path.join(dir, `${archive}.png`);
    const dims = extractMapImageFromArchive(path.join(dir, archive), out, {
      sevenZip: bin,
      // the display name deliberately shares nothing with the inner file
      // name — extraction must still take the lone .smf entry
      mapName: "Completely Different Map Name",
    });
    assert.ok(dims, `extraction from ${archive} failed`);
    assert.equal(dims.w, 512);
    assert.equal(dims.h, 512);
    assert.ok(existsSync(out));
  }
});
