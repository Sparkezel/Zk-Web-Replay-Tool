export { parseDemo, parseDemoHeader, parsePlayerStat, parseTeamStat } from "./demo/parse.js";
export { parseSdfzFile, parseDemoAuto, isSdfz } from "./demo/load.js";
export type { ParsedDemo, DemoFileHeader, PlayerStatistics, TeamStatistics } from "./demo/parse.js";
export { parseStartscript, roster } from "./demo/startscript.js";
export type { ParsedStartscript, StartscriptSection, ParsedRosterPlayer } from "./demo/startscript.js";
export { parseDemoStream, NetMsg } from "./demo/stream.js";
export type { DemoStreamResult, ChatEvent, MapDrawEvent, GameOverEvent } from "./demo/stream.js";
export { writeZkr, readZkr, SECTION, ZKR_VERSION } from "./zkr/container.js";
export type { SectionInput, ZkrSection } from "./zkr/container.js";
export {
  buildZkrFromDemo, buildMetaSection, buildRosterSection, buildChatSection,
  buildMacroSection, buildEcoSection, buildPlayerStatsSection, buildMapDrawSection,
} from "./zkr/build.js";

/* M2 resim daemon */
export { CODEC_RAW, CODEC_DEFLATE, CODEC_ZSTD, bestCodec } from "./zkr/container.js";
export { engineZipUrl, demoUrl, battleDetailUrl, RAPID_REPO_ZK, prDownloaderArgs, HEADLESS_BINARY } from "./config/urls.js";
export type { EnginePlatform } from "./config/urls.js";
export { classifyProjectile, presetRecords, PROJ_CLASS_NAMES } from "./daemon/classify.js";
export type { WeaponDefInfo, ProjectilePreset } from "./daemon/classify.js";
export { ingestLine, ingestEvent, newSnapshot, ProjClass } from "./daemon/events.js";
export type { SnapshotData, UnitTrack, EvntRecord, ProjTrack, LinkRecord, UnitDefInfo, PosSample } from "./daemon/events.js";
export { quantize, encodePos, encodeEvents, encodeProjectiles, encodeLinks, buildZkrFromResim } from "./daemon/pack.js";
export type { PackOptions } from "./daemon/pack.js";
export { provisionEngine, downloadFile, extractZip, headlessBinaryPath } from "./daemon/provision.js";
export { loadDemoFile, runHeadlessCapture, writeStartscript } from "./daemon/run.js";
export { resimBattle, parseArgs, injectWidget } from "./daemon/index.js";
export type { ResimJob, ResimResult } from "./daemon/index.js";
export { decodeDxt1, encodePng, findMapFile, extractMapImage } from "./daemon/mapimage.js";
export { SNAPSHOT_WIDGET_LUA, SNAPSHOT_WIDGET_NAME } from "./daemon/snapshot_widget.js";
