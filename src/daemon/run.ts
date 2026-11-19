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
  /** writable dir for engine output (infolog.txt, cache/); passed as SPRING_WRITEDIR */
  writeDir?: string;
  /** expected final sim frame, from the demo stream (drives progress %) */
  lastFrame?: number;
  /** seconds past game-over before lingering engines get killed (default 30) */
  gameOverGraceSec?: number;
  /** seconds between status lines (default 5, 0 disables) */
  statusEverySec?: number;
  /** kill the engine when zero ZKR lines were captured this many seconds after the sim started (default 120, 0 disables); a broken widget would otherwise waste the whole timeout */
  noZkrSec?: number;
  log?: Logger;
}

export interface RunResult {
  code: number | null;
  timedOut: boolean;
  snapshot: SnapshotData;
  rawLines: number;
  zkrLines: number;
  /** highest sim frame seen on stdout (`[f=N]`) */
  simFrame: number;
  /** final phase of the run (booting/scan/starting/simulating/over) */
  phase: string;
}

export function loadDemoFile(demoPath: string): ParsedDemo {
  return parseDemoAuto(readFileSync(demoPath));
}

/**
 * Extract the startscript to a file the engine can load (`script.txt`).
 * `hostip` is force-bound to localhost: demo scripts recorded by online
 * autohosts carry the host's public IP, and the engine aborts at StartServer
 * when it cannot bind that address for an offline resim.
 */
export function writeStartscript(demo: ParsedDemo, destPath: string): string {
  const raw = demo.startscript.raw ?? "";
  const patched = /\bhostip\s*=/i.test(raw)
    ? raw.replace(/\bhostip\s*=.*$/im, "hostip=127.0.0.1")
    : raw;
  writeFileSync(destPath, patched);
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
  let gameOverAt = 0;
  let warnedGameOver = false;
  let simStartedAt = 0;
  let simFrame = 0;
  let phase = "booting";

  const PHASE_RANK: Record<string, number> = { booting: 0, scan: 1, starting: 2, simulating: 3, over: 4 };
  const advance = (next: "scan" | "starting" | "simulating" | "over") => {
    if (PHASE_RANK[next] > PHASE_RANK[phase]) phase = next;
  };

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.dataDir) env.SPRING_DATADIR = opts.dataDir;
  if (opts.writeDir) env.SPRING_WRITEDIR = opts.writeDir;
  if (opts.writeDir) mkdirSync(opts.writeDir, { recursive: true });

  // persist the engine's raw output; when it crashes before game start the
  // fatal line only ever shows up here, never inside the packed artifact
  const rawOutput: string[] = [];

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

    const startedAt = Date.now();
    const watchdog = setInterval(() => {
      const noZkrMs = (opts.noZkrSec ?? 120) * 1000;
      if (noZkrMs > 0 && simStartedAt > 0 && zkrLines === 0 && Date.now() - simStartedAt > noZkrMs) {
        log.warn(`sim running for ${opts.noZkrSec ?? 120}s with zero ZKR lines captured; assuming broken widget, killing engine (pid ${proc.pid})`);
        log.warn("check the widget load errors in engine-stdout.log / logs dir; extend the grace with --no-zkr-sec 0 to disable this abort");
        clearInterval(watchdog);
        proc.kill("SIGKILL");
        return;
      }
      const graceMs = (opts.gameOverGraceSec ?? 30) * 1000;
      if (graceMs > 0 && gameOverAt > 0 && Date.now() - gameOverAt > graceMs) {
        if (!warnedGameOver) log.warn(`game over captured over ${opts.gameOverGraceSec ?? 30}s ago; killing lingering engine (pid ${proc.pid})`);
        warnedGameOver = true;
        proc.kill("SIGKILL");
      }
    }, 1000);
    const statusEveryMs = (opts.statusEverySec ?? 5) * 1000;
    let lastStatusAt = 0;
    let lastStatusFrame = 0;
    const statusTimer = setInterval(() => {
      const now = Date.now();
      const elapsedSec = Math.round((now - startedAt) / 1000);
      let speedStr = "";
      if (lastStatusAt !== 0 && simFrame !== lastStatusFrame) {
        const fps = (simFrame - lastStatusFrame) / ((now - lastStatusAt) / 1000);
        speedStr = ` ${(fps / 30).toFixed(2)}x (${fps.toFixed(0)}fps)`;
      }
      lastStatusAt = now;
      lastStatusFrame = simFrame;
      const pct = opts.lastFrame ? Math.min(100, Math.round((100 * simFrame) / opts.lastFrame)) : "?";
      log.info(`engine: ${phase} frame=${simFrame}${opts.lastFrame ? `/${opts.lastFrame} (${pct}%)` : ""}${speedStr} zkr=${zkrLines} stdout=${rawLines} ${elapsedSec}s`);
    }, statusEveryMs);

    let stdoutBuf = "";
    proc.stdout!.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        rawLines++;
        rawOutput.push(line);
        if (/using writeable data-directory|\[~CBufferedArchive\]|\[AS::/.test(line)) advance("scan");
        if (/\[PreGame::StartServer\]|\[GameServer\]/.test(line)) advance("starting");
        const fm = /\[f=(\d+)\]/.exec(line);
        if (fm) {
          if (simStartedAt === 0) simStartedAt = Date.now();
          simFrame = Math.max(simFrame, Number(fm[1]));
          advance("simulating");
        }
        const res = ingestLine(snapshot, line);
        if (res.isZkr) {
          zkrLines++;
          if (!res.ok) log.warn(`malformed ZKR line: ${line.slice(0, 120)}`);
        }
        if (snapshot.gameOvers.length > 0) {
          advance("over");
          if (gameOverAt === 0) gameOverAt = Date.now();
        }
      }
    });
    const errChunks: Buffer[] = [];
    proc.stderr!.on("data", (c: Buffer) => errChunks.push(c));

    proc.on("error", (err) => {
      clearTimeout(timeout);
      clearInterval(watchdog);
      clearInterval(statusTimer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timeout);
      clearInterval(watchdog);
      clearInterval(statusTimer);
      log.info(`engine exited code=${code} timedOut=${timedOut} zkrLines=${zkrLines}/${rawLines} frame=${simFrame} phase=${phase}`);
      if (opts.logDir) {
        mkdirSync(opts.logDir, { recursive: true });
        writeFileSync(path.join(opts.logDir, "engine-stdout.log"), rawOutput.join("\n"));
        writeFileSync(path.join(opts.logDir, "engine-stderr.log"), Buffer.concat(errChunks));
      }
      if (zkrLines === 0 && rawOutput.length > 0) {
        log.warn(`no ZKR frames captured; last engine output:\n${rawOutput.slice(-5).join("\n")}`);
      }
      resolve({ code, timedOut, snapshot, rawLines, zkrLines, simFrame, phase });
    });
  });
}
