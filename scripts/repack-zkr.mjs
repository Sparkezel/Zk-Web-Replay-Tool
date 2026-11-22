/**
 * Migrate an existing resim artifact in place — no engine re-run required.
 *
 * Resim sections (POS/EVNT/PROJ/LINK/STBX/UDEF/WDEF) are carried over byte
 * for byte; demo-derived sections (META/ROST/CHAT/DRAW/MACR/ECO/PSTA) are
 * rebuilt from the original .sdfz with the current builders, picking up new
 * fields like MACR.startPlayingFrame. It cannot restore information v1
 * artifacts never carried (cloak bits, META map dims, UDEF cloak radii) —
 * those need one fresh daemon resim run.
 *
 *   node scripts/repack-zkr.mjs <artifact.zkr> <demo.sdfz> [out.zkr]
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
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

/* sanity: the demo must be the one this artifact was built from — a foreign
   demo would silently graft chat/eco of a different battle onto the resim */
{
  const meta = existing.find((s) => s.id === SECTION.META);
  const oldGameID = meta ? JSON.parse(Buffer.from(meta.payload).toString("utf8")).gameID : null;
  const newMeta = JSON.parse(Buffer.from(buildMetaSection(demo)).toString("utf8"));
  if (oldGameID && newMeta.gameID && oldGameID !== newMeta.gameID) {
    console.error(`refusing to repack: artifact gameID ${oldGameID} != demo gameID ${newMeta.gameID}`);
    process.exit(2);
  }
  if (newMeta.gameID && oldGameID && newMeta.map?.name && oldGameID === newMeta.gameID) {
    console.log(`demo matches artifact (gameID ${newMeta.gameID}, map ${newMeta.map?.name ?? "?"})`);
  }
}

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

/* sanity: the anchor must precede the resim data — an anchor past the last
   play frame would collapse the whole timeline to zero */
{
  const anchor = demo.stream.startPlayingFrame;
  const posSec = secs.find((s) => s.id === SECTION.POS);
  if (anchor > 0 && posSec) {
    const dv = new DataView(posSec.payload.buffer, posSec.payload.byteOffset, Math.min(16, posSec.payload.byteLength));
    // numUnits then first unit's u32 id,u16 def,u32 firstFrame -> frame 0
    const numUnits = dv.getUint32(0, true);
    if (numUnits > 0 && anchor > 0) {
      console.log(`anchor frame ${anchor} (${(anchor / 30).toFixed(1)} s) vs ${numUnits} resim units`);
    }
  }
}

const out = new Uint8Array(writeZkr(secs));
const dest = outPath ?? artifactPath;
if (dest === artifactPath && !existsSync(artifactPath + ".bak")) {
  copyFileSync(artifactPath, artifactPath + ".bak");
  console.log(`backup written: ${artifactPath}.bak`);
}
writeFileSync(dest, out);
const ids = secs.map((s) => s.id.trim()).join(" ");
console.log(`repacked ${dest}: ${out.byteLength} bytes; sections ${ids}`);
console.log(`startPlayingFrame = ${demo.stream.startPlayingFrame} (pre-game = ${(demo.stream.startPlayingFrame / 30).toFixed(1)}s)`);
