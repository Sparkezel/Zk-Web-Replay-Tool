/**
 * M2 resim daemon CLI.
 *
 *   zkr-daemon --demo battle.sdfz | --battle <lobbyID>
 *              [--out battle.zkr] [--work-dir .zkr-work]
 *              [--engine-dir dir | --engine-version <ver>]
 *              [--pos-rate N] [--projectiles none|beams|heavy|all]
 *              [--script springscript.txt] [--no-resim]
 *              [--timeout SEC] [--status-every-sec N] [--game-over-grace-sec N]
 *              [--speed N]   sim-speed multiplier (default 5 for fast resim)
 *              [--no-zkr-sec N]  abort when no ZKR captured N sec into the sim (default 120, 0 disables)
 *
 * Without an engine available the daemon still packs a valid artifact from
 * the cheap-parse demo sections (M1 data only, no POS/EVNT/PROJ/LINK rows).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseDemoAuto } from "../demo/load.js";
import type { ParsedDemo } from "../demo/parse.js";
import { buildZkrFromDemo } from "../zkr/build.js";
import { demoUrl } from "../config/urls.js";
import { downloadFile, provisionEngine, headlessBinaryPath, consoleLogger, type Logger } from "./provision.js";
import { stageDataDir } from "./stage.js";
import { extractMapImage, findMapFile } from "./mapimage.js";
import { newSnapshot, type SnapshotData } from "./events.js";
import { loadDemoFile, runHeadlessCapture, writeStartscript } from "./run.js";
import { buildZkrFromResim, type PackOptions } from "./pack.js";
import { SNAPSHOT_WIDGET_LUA, SNAPSHOT_WIDGET_NAME, speedUpPressesFor } from "./snapshot_widget.js";
import type { ProjectilePreset } from "./classify.js";

export type { ProjectilePreset } from "./classify.js";

export interface ResimJob {
  battleID?: string;
  demoPath?: string;
  workDir: string;
  outPath?: string;
  engineDir?: string;
  engineVersion?: string;
  scriptPath?: string;
  /** root of the game-data tree (containing `games/` and `maps/`); engine cwd */
  dataRoot?: string;
  posRate?: number;
  projectiles?: ProjectilePreset;
  skipResim?: boolean;
  /** hard engine kill timeout in seconds (default 1800) */
  timeoutSec?: number;
  /** seconds between live `engine: ...` status lines (default 5, 0 disables) */
  statusEverySec?: number;
  /** seconds past game-over before a lingering engine gets killed (default 30, 0 disables) */
  gameOverGraceSec?: number;
  /** wanted sim-speed multiplier applied via engine /speedup (default 5) */
  speedFactor?: number;
  /** kill the resim when zero ZKR lines were captured this many seconds after sim start (default 120, 0 disables) */
  zkrAbortSec?: number;
}

export interface ResimResult {
  battleID: string;
  demoPath: string;
  artifactPath: string;
  resimulated: boolean;
  zkrLines: number;
  sections: string[];
}

export async function resimBattle(job: ResimJob, log: Logger = consoleLogger): Promise<ResimResult> {
  const battleID = job.battleID ?? "local";
  const root = path.resolve(job.workDir);
  mkdirSync(path.join(root, "demos"), { recursive: true });

  const demoPath = job.demoPath ?? path.join(root, "demos", `${battleID}.sdfz`);
  if (job.demoPath === undefined && job.battleID !== undefined && !existsSync(demoPath)) {
    await downloadFile(demoUrl(job.battleID), demoPath, log);
  }
  if (!existsSync(demoPath)) throw new Error(`demo not found: ${demoPath}`);
  log.info(`parsing demo ${demoPath} ...`);
  const demo: ParsedDemo = loadDemoFile(demoPath);
  log.info(`parsed demo ${path.basename(demoPath)}: engine=${demo.header.versionString} players=${demo.header.numPlayers} teams=${demo.header.numTeams ?? "?"} complete=${demo.complete}`);

  let zkrLines = 0;
  let resimulated = false;
  let snap: SnapshotData | undefined;

  if (!job.skipResim) {
    const engineDir = job.engineDir ?? (job.engineVersion
      ? await provisionEngine(job.engineVersion, { cacheDir: path.join(root, "engines"), log })
      : undefined);
    if (engineDir !== undefined && headlessBinaryPath(engineDir) !== null) {
      // script.txt stays as a debug artifact; unless the user overrides it
      // with --script, the engine runs the demo itself in replay mode, which
      // replays the recorded player command stream. A bare startscript would
      // reproduce an empty game (commands live only in the demo stream).
      writeStartscript(demo, path.resolve(root, "script.txt"));
      const gamePath = job.scriptPath ?? path.resolve(demoPath);
      const dataDir = job.dataRoot !== undefined
        ? stageDataDir({ dataRoot: job.dataRoot, workDir: root, log })
        : undefined;
      const speedFactor = job.speedFactor ?? 5;
      const projPreset = job.projectiles ?? "heavy";
      if (dataDir !== undefined) {
        mkdirSync(path.join(dataDir, "LuaUI", "Widgets"), { recursive: true });
        injectWidget(dataDir, speedFactor, log, projPreset);
      }
      const writeDir = path.join(root, "engine-write");
      mkdirSync(path.join(writeDir, "LuaUI", "Widgets"), { recursive: true });
      injectWidget(writeDir, speedFactor, log, projPreset);
      log.info(`resimulating battle ${battleID} with engine at ${engineDir}`);
      const run = await runHeadlessCapture({
        engineDir, scriptPath: gamePath, logDir: path.join(root, "logs"), log,
        writeDir,
        dataDir,
        timeoutMs: job.timeoutSec !== undefined ? job.timeoutSec * 1000 : undefined,
        statusEverySec: job.statusEverySec,
        gameOverGraceSec: job.gameOverGraceSec,
        noZkrSec: job.zkrAbortSec,
        lastFrame: Math.round(demo.stream.lastModGameTime * 30),
      });
      snap = run.snapshot;
      zkrLines = run.zkrLines;
      log.info(`resim reached frame=${run.simFrame} phase=${run.phase}`);
      resimulated = zkrLines > 0;
      if (zkrLines === 0) log.warn("engine produced no ZKR frames; falling back to cheap-parse sections");
    } else {
      log.warn("engine not available; packing cheap-parse sections only (--engine-dir or --engine-version enables resim)");
    }
  }

  const artifactPath = job.outPath ?? path.join(root, "artifacts", `${battleID}.zkr`);
  log.info(`packing ${snap !== undefined && zkrLines > 0 ? "resim" : "cheap-parse"} sections ...`);
  mkdirSync(path.dirname(artifactPath), { recursive: true });
  const zkr = snap !== undefined && zkrLines > 0
    ? buildZkrFromResim(snap, { demo, posRate: job.posRate, projectiles: job.projectiles })
    : buildZkrFromDemo(demo);
  writeFileSync(artifactPath, zkr);
  log.info(`artifact written: ${artifactPath} (${zkr.byteLength} bytes, resim=${resimulated})`);

  // map backdrop: every .smf embeds its own minimap; decode it for the viewer
  const searchRoots = [path.join(root, "data", "maps"), path.join(root, "maps")];
  const smfPath = findMapFile(searchRoots);
  if (smfPath === null) {
    log.warn("no .smf map file in the staged data; viewer keeps the plain backdrop (--data-root enables map extraction)");
  } else {
    const mapPng = path.join(path.dirname(artifactPath), "map.png");
    const dims = extractMapImage(smfPath, mapPng);
    if (dims !== null) {
      log.info(`map backdrop extracted: ${mapPng} (${dims.w}x${dims.h}) from ${path.basename(smfPath)}`);
    } else {
      log.warn(`map minimap extraction failed for ${smfPath}; viewer keeps the plain backdrop`);
    }
  }

  return {
    battleID,
    demoPath,
    artifactPath,
    resimulated,
    zkrLines,
    sections: snap === undefined
      ? ["META", "ROST", "CHAT", "DRAW", "MACR", "ECO", "PSTA"]
      : ["META", "ROST", "UDEF", "WDEF", "POS", "EVNT", "PROJ", "LINK", "CHAT", "DRAW", "MACR", "ECO", "PSTA"],
  };
}

export function injectWidget(
  gameDataDir: string,
  speedFactor = 5,
  log: Logger = consoleLogger,
  projPreset: ProjectilePreset = "heavy",
): string | null {
  const widgetsDir = path.join(gameDataDir, "LuaUI", "Widgets");
  if (!existsSync(widgetsDir)) {
    log.warn(`no LuaUI/Widgets dir at ${widgetsDir}; widget not injected`);
    return null;
  }
  const speedPresses = speedUpPressesFor(speedFactor);
  const widgetSource = SNAPSHOT_WIDGET_LUA
    .replace(/__ZKR_SPEEDUP_PRESSES__/g, String(speedPresses))
    .replace(/__ZKR_SPEED_FACTOR__/g, String(speedFactor))
    .replace(/__ZKR_PROJ_MODE__/g, projPreset);
  const widgetPath = path.join(widgetsDir, SNAPSHOT_WIDGET_NAME);
  writeFileSync(widgetPath, widgetSource);
  log.info(`snapshot widget injected: ${widgetPath}`);
  return widgetPath;
}

/** Parse CLI argv into a ResimJob. Exported for tests. */
export function parseArgs(argv: string[]): ResimJob {
  const job: ResimJob = { workDir: ".zkr-work", projectiles: "heavy", posRate: 1 };
  const presetValues = new Set(["none", "beams", "heavy", "all"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--battle": job.battleID = next(); break;
      case "--demo": job.demoPath = next(); break;
      case "--out": job.outPath = next(); break;
      case "--work-dir": job.workDir = next(); break;
      case "--engine-dir": job.engineDir = next(); break;
      case "--engine-version": job.engineVersion = next(); break;
      case "--script": job.scriptPath = next(); break;
      case "--pos-rate": job.posRate = Math.max(1, Number(next())); break;
      case "--projectiles": {
        const v = next();
        if (!presetValues.has(v)) throw new Error(`invalid --projectiles ${v}`);
        job.projectiles = v as ProjectilePreset;
        break;
      }
      case "--no-resim": job.skipResim = true; break;
      case "--speed": job.speedFactor = Math.max(1, Number(next()) || 1); break;
      case "--no-zkr-sec": job.zkrAbortSec = Math.max(0, Number(next()) | 0); break;
      case "--data-root": job.dataRoot = next(); break;
      case "--timeout": job.timeoutSec = Math.max(1, Number(next()) | 0); break;
      case "--status-every-sec": job.statusEverySec = Math.max(0, Number(next()) | 0); break;
      case "--game-over-grace-sec": job.gameOverGraceSec = Math.max(0, Number(next()) | 0); break;
      default: throw new Error(`unknown flag ${a}`);
    }
  }
  if (!job.battleID && !job.demoPath) throw new Error("one of --battle or --demo is required");
  return job;
}

export async function main(argv: string[]): Promise<number> {
  const log = consoleLogger;
  try {
    const job = parseArgs(argv);
    log.info(`zkr-daemon: demo=${job.demoPath ?? job.battleID} out=${job.outPath ?? "<workDir>"} projectiles=${job.projectiles} posRate=${job.posRate} skipResim=${job.skipResim === true} timeoutSec=${job.timeoutSec ?? 1800} statusEverySec=${job.statusEverySec ?? 5}`);
    const result = await resimBattle(job, log);
    log.info(`done: battle=${result.battleID} artifact=${result.artifactPath} resim=${result.resimulated} zkrLines=${result.zkrLines}`);
    return 0;
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    log.error("run failed; no artifact was written (or a stale one is left in place)");
    return 1;
  }
}

// executed directly: `node dist/daemon/index.js --demo ...`
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
