/**
 * Engine + demo provisioning for the resim daemon.
 *
 * Engine zips are published by Zero-K per version; the daemon caches the
 * unpacked engine per (platform, version) pair and refuses to resim against a
 * mismatched engine (the barreplay rule, adapted). Works on Windows 10 native
 * (bsdtar ships with Windows 10 and handles zip), Linux, and WSL2.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HEADLESS_BINARY, engineZipUrl, type EnginePlatform } from "../config/urls.js";

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export const consoleLogger: Logger = {
  info: (m) => console.log(`[daemon] ${m}`),
  warn: (m) => console.warn(`[daemon] ${m}`),
  error: (m) => console.error(`[daemon] ${m}`),
};

export function spawnProcess(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(0);
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

export async function downloadFile(url: string, destination: string, log: Logger = consoleLogger): Promise<void> {
  mkdirSync(path.dirname(destination), { recursive: true });
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`download failed ${res.status}: ${url}`);
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(destination));
  log.info(`downloaded ${statSync(destination).size} bytes <- ${url}`);
}

/** Extract a zip with the system bsdtar/tar (handles zip on Win10 and Linux). */
export async function extractZip(zipPath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  await spawnProcess("tar", ["-xf", zipPath], { cwd: destDir });
}

export function headlessBinaryPath(engineDir: string, platform: NodeJS.Platform = process.platform): string | null {
  const name = HEADLESS_BINARY[platform] ?? "spring-headless";
  return findFileUpTo(engineDir, name, 3);
}

function findFileUpTo(dir: string, name: string, maxDepth: number): string | null {
  const direct = path.join(dir, name);
  if (existsSync(direct)) return direct;
  if (maxDepth <= 0) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const hit = findFileUpTo(path.join(dir, entry.name), name, maxDepth - 1);
    if (hit) return hit;
  }
  return null;
}

export interface ProvisionOptions {
  platform?: EnginePlatform;
  cacheDir?: string;
  log?: Logger;
}

/**
 * Download + unpack the engine for `version` into `<cacheDir>/engines/<version>`,
 * or reuse an existing unpacked engine. Returns the engine directory, or
 * throws on download/extract failure.
 */
export async function provisionEngine(
  version: string,
  opts: ProvisionOptions = {},
): Promise<string> {
  const log = opts.log ?? consoleLogger;
  const platform = opts.platform ?? (process.platform === "win32" ? "win64" : "linux64");
  const cacheDir = opts.cacheDir ?? path.join(".zkr-cache", "engines");
  const engineDir = path.join(cacheDir, version);
  const marker = path.join(engineDir, ".zkr-provisioned");
  if (existsSync(marker)) {
    log.info(`engine ${version} already provisioned at ${engineDir}`);
    return engineDir;
  }
  const zipPath = path.join(cacheDir, `${version}.zip`);
  if (!existsSync(zipPath)) {
    log.info(`downloading engine ${version} (${platform})`);
    await downloadFile(engineZipUrl(version, platform), zipPath, log);
  }
  log.info(`unpacking engine ${version}`);
  await extractZip(zipPath, engineDir);
  if (headlessBinaryPath(engineDir) === null) {
    throw new Error(
      `no ${HEADLESS_BINARY[process.platform] ?? "spring-headless"} found in engine ${version}; ` +
      `win64 zips that lack the headless binary need the Linux build or WSL2`,
    );
  }
  writeFileSync(marker, "ok\n");
  return engineDir;
}
