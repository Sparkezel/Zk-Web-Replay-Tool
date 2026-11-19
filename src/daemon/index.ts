/**
 * M2 resim daemon CLI.
 *
 *   zkr-daemon --demo battle.sdfz | --battle <lobbyID>
 *              [--out battle.zkr] [--work-dir .zkr-work]
 *              [--engine-dir dir | --engine-version <ver>]
 *              [--pos-rate N] [--projectiles none|beams|heavy|all]
 *              [--script springscript.txt] [--no-resim]
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
import { newSnapshot, type SnapshotData } from "./events.js";
import { loadDemoFile, runHeadlessCapture, writeStartscript } from "./run.js";
import { buildZkrFromResim, type PackOptions } from "./pack.js";
import { SNAPSHOT_WIDGET_LUA, SNAPSHOT_WIDGET_NAME } from "./snapshot_widget.js";
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
  posRate?: number;
  projectiles?: ProjectilePreset;
  skipResim?: boolean;
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
  const root = job.workDir;
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
      const scriptPath = job.scriptPath ?? writeStartscript(demo, path.join(root, "script.txt"));
      log.info(`resimulating battle ${battleID} with engine at ${engineDir}`);
      const run = await runHeadlessCapture({
        engineDir, scriptPath, logDir: path.join(root, "logs"), log,
      });
      snap = run.snapshot;
      zkrLines = run.zkrLines;
      resimulated = true;
    } else {
      log.warn("engine not available; packing cheap-parse sections only (--engine-dir or --engine-version enables resim)");
    }
  }

  const artifactPath = job.outPath ?? path.join(root, "artifacts", `${battleID}.zkr`);
  log.info(`packing ${snap !== undefined ? "resim" : "cheap-parse"} sections ...`);
  mkdirSync(path.dirname(artifactPath), { recursive: true });
  const zkr = snap !== undefined
    ? buildZkrFromResim(snap, { demo, posRate: job.posRate, projectiles: job.projectiles })
    : buildZkrFromDemo(demo);
  writeFileSync(artifactPath, zkr);
  log.info(`artifact written: ${artifactPath} (${zkr.byteLength} bytes, resim=${resimulated})`);

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

export function injectWidget(gameDataDir: string, log: Logger = consoleLogger): string | null {
  const widgetsDir = path.join(gameDataDir, "LuaUI", "Widgets");
  if (!existsSync(widgetsDir)) {
    log.warn(`no LuaUI/Widgets dir at ${widgetsDir}; widget not injected`);
    return null;
  }
  const widgetPath = path.join(widgetsDir, SNAPSHOT_WIDGET_NAME);
  writeFileSync(widgetPath, SNAPSHOT_WIDGET_LUA);
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
    log.info(`zkr-daemon: demo=${job.demoPath ?? job.battleID} out=${job.outPath ?? "<workDir>"} projectiles=${job.projectiles} posRate=${job.posRate} skipResim=${job.skipResim === true}`);
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
