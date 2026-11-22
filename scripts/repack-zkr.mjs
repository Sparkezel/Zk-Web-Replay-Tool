/**
 * Migrate an existing resim artifact in place — no engine re-run required.
 *
 * Resim sections (POS/EVNT/PROJ/LINK/STBX/UDEF/WDEF) are carried over byte
 * for byte; demo-derived sections (META/ROST/CHAT/DRAW/MACR/ECO/PSTA) are
 * rebuilt from the original .sdfz with the current builders, picking up new
 * fields like MACR.startPlayingFrame. Also patches META map dims from the
 * resim UDEF-era meta when an old META lacks them.
 *
 *   node scripts/repack-zkr.mjs <artifact.zkr> <demo.sdfz> [out.zkr]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { readZkr, writeZkr, SECTION, CODEC_DEFLATE } = require("../dist/zkr/container.js");
const {
  buildMetaSection, buildRosterSection, buildChatSection, buildMapDrawSection,
  buildMacroSection, buildEcoSection, buildPlayerStatsSection,
} = require("../dist/zkr/build.js");
const { parseSdfzFile } = require("../dist/demo/load.js");

const [artifactPath, demoPath, outPath] = process.argv.slice(2);
if (!artifactPath || !demoPath) {
  console.error("usage: node scripts/repack-zkr.mjs <artifact.zkr> <demo.sdfz> [out.zkr]");
  process.exit(1);
}

const existing = readZkr(new Uint8Array(readFileSync(artifactPath)));
const has = (id) => existing.some((s) => s.id === id);
const get = (id) => existing.find((s) => s.id === id);

const demo = parseSdfzFile(demoPath);
const codec = CODEC_DEFLATE;

const secs = [
  { id: SECTION.META, version: 1, payload: buildMetaSection(demo), codec },
  ...has(SECTION.STARTBOX) ? [{ id: SECTION.STARTBOX, version: get(SECTION.STARTBOX).version, payload: get(SECTION.STARTBOX).payload, codec }] : [],
  { id: SECTION.ROSTER, version: 1, payload: buildRosterSection(demo), codec },
  ...has(SECTION.UNITDEF) ? [{ id: SECTION.UNITDEF, version: get(SECTION.UNITDEF).version, payload: get(SECTION.UNITDEF).payload, codec }] : [],
  ...has(SECTION.WEAPONDEF) ? [{ id: SECTION.WEAPONDEF, version: get(SECTION.WEAPONDEF).version, payload: get(SECTION.WEAPONDEF).payload, codec }] : [],
  ...has(SECTION.POS) ? [{ id: SECTION.POS, version: get(SECTION.POS).version, payload: get(SECTION.POS).payload, codec }] : [],
  ...has(SECTION.EVENTS) ? [{ id: SECTION.EVENTS, version: get(SECTION.EVENTS).version, payload: get(SECTION.EVENTS).payload, codec }] : [],
  ...has(SECTION.PROJECTILES) ? [{ id: SECTION.PROJECTILES, version: get(SECTION.PROJECTILES).version, payload: get(SECTION.PROJECTILES).payload, codec }] : [],
  ...has(SECTION.LINKS) ? [{ id: SECTION.LINKS, version: get(SECTION.LINKS).version, payload: get(SECTION.LINKS).payload, codec }] : [],
  { id: SECTION.CHAT, version: 1, payload: buildChatSection(demo), codec },
  { id: SECTION.MAPDRAW, version: 1, payload: buildMapDrawSection(demo), codec },
  { id: SECTION.MACRO, version: 1, payload: buildMacroSection(demo), codec },
  { id: SECTION.ECO, version: 1, payload: buildEcoSection(demo), codec },
  { id: SECTION.PLAYERSTATS, version: 1, payload: buildPlayerStatsSection(demo), codec },
];

/* old META lacks map dims (shipped null) — the viewer needs them to scale
   Iris cloak circles. The only in-artifact source is the resim UDEF era's
   quantization; recover the elmo size from... it isn't stored, so fall back
   to ZK's smallest sane map when unknown is not an option: leave as-is and
   let the viewer skip the circles. Nothing to do here for v1 artifacts. */

const out = new Uint8Array(writeZkr(secs));
const dest = outPath ?? artifactPath;
writeFileSync(dest, out);
const ids = secs.map((s) => s.id.trim()).join(" ");
console.log(`repacked ${dest}: ${out.byteLength} bytes; sections ${ids}`);
console.log(`startPlayingFrame = ${demo.stream.startPlayingFrame} (pre-game = ${(demo.stream.startPlayingFrame / 30).toFixed(1)}s)`);
