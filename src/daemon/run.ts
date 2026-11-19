/**
 * Headless resim run: spawn `spring-headless` with the demo's startscript,
 * capture `ZKR <json>` stdout lines into a SnapshotData, and guarantee the
 * engine process cannot outlive its timeout. Cross-platform (Win10 native,
 * Linux, WSL2) — the only platform-specific bit is the binary name.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseDemoAuto, isSdfz } from "../demo/load.js";
import type { ParsedDemo } from "../demo/parse.js";
import { ingestLine, newSnapshot, type SnapshotData } from "./events.js";
import { headlessBinaryPath, consoleLogger, type Logger } from "./provision.js";

export interface RunOptions {
  /** unpacked engine directory containing `spring-headless[.exe]` */
  engineDir: string;
  /** startscript to run (usually extracted from the demo) */
  scriptPath: string;
  /** writethrough dir for raw engine stdout (debugging), optional */
  logDir?: string;
  /** hard kill timeout in ms (default 30 min) */
  timeoutMs?: number;
  /** working directory for the engine process (defaults to the engine dir) */
  cwd?: string;
  /** extra archive roots (`games/`, `maps/`, `packages/`); passed as SPRING_DATADIR */
  dataDir?: string;
  log?: Logger;
}

export interface RunResult {
  code: number | null;
  timedOut: boolean;
  snapshot: SnapshotData;
  rawLines: number;
  zkrLines: number;
}

export function loadDemoFile(demoPath: string): ParsedDemo {
  return parseDemoAuto(readFileSync(demoPath));
}

/** Extract the startscript to a file the engine can load (`script.txt`). */
export function writeStartscript(demo: ParsedDemo, destPath: string): string {
  writeFileSync(destPath, demo.startscript.raw ?? "");
  return destPath;
}

export function runHeadlessCapture(opts: RunOptions): Promise<RunResult> {
  const log = opts.log ?? consoleLogger;
  const enginePath = headlessBinaryPath(opts.engineDir);
  if (!enginePath) {
    return Promise.reject(new Error(`no headless engine binary in ${opts.engineDir}`));
  }
  const snapshot = newSnapshot();
  let rawLines = 0;
  let zkrLines = 0;
  let timedOut = false;

  const env = opts.dataDir
    ? { ...process.env, SPRING_DATADIR: opts.dataDir }
    : { ...process.env };
  return new Promise((resolve, reject) => {
    const proc = spawn(enginePath, [opts.scriptPath], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: opts.cwd ?? opts.engineDir,
      env,
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      log.warn(`engine exceeded timeout, killing (pid ${proc.pid})`);
      proc.kill("SIGKILL");
    }, opts.timeoutMs ?? 30 * 60 * 1000);

    let stdoutBuf = "";
    proc.stdout!.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        rawLines++;
        if (rawLines % 10000 === 0) log.info(`capturing ... ${rawLines} stdout lines, ${zkrLines} ZKR`);
        const res = ingestLine(snapshot, line);
        if (res.isZkr) {
          zkrLines++;
          if (!res.ok) log.warn(`malformed ZKR line: ${line.slice(0, 120)}`);
        }
      }
    });
    const errChunks: Buffer[] = [];
    proc.stderr!.on("data", (c: Buffer) => errChunks.push(c));

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timeout);
      log.info(`engine exited code=${code} timedOut=${timedOut} zkrLines=${zkrLines}/${rawLines}`);
      if (opts.logDir) {
        mkdirSync(opts.logDir, { recursive: true });
        writeFileSync(path.join(opts.logDir, "engine-stderr.log"), Buffer.concat(errChunks));
      }
      resolve({ code, timedOut, snapshot, rawLines, zkrLines });
    });
  });
}
