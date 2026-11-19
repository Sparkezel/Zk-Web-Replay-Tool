/** Load a .sdfz (gzip) file from disk or in the wild. */
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { parseDemo, type ParsedDemo, type ParseOptions } from "./parse.js";

export function parseSdfzFile(path: string, opts: ParseOptions = {}): ParsedDemo {
  const gz = readFileSync(path);
  return parseDemo(gunzipSync(gz), opts);
}

export function isSdfz(buf: Uint8Array): boolean {
  return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

export function parseDemoAuto(buf: Uint8Array, opts: ParseOptions = {}): ParsedDemo {
  return parseDemo(isSdfz(buf) ? gunzipSync(buf) : buf, opts);
}
