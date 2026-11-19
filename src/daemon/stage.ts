/**
 * Isolated datadir staging for resim runs.
 *
 * The engine scans a fixed set of archive roots (`maps/`, `games/`,
 * `base/`, `packages/`) inside each data dir. Instead of pointing it at the
 * host game folder directly -- where it could write infolog.txt, cache/, or
 * springsettings.cfg into the install -- we build a private datadir under the
 * daemon work dir and junction-link the read-only archive roots into it.
 * Engine writes are redirected to `engine-write/` via SPRING_WRITEDIR, so the
 * game install is only ever read, never touched.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync, symlinkSync, statSync } from "node:fs";
import path from "node:path";
import type { Logger } from "./provision.js";

/** Archive roots the engine scans inside each data dir. */
const ARCHIVE_ROOTS = ["maps", "games", "base", "packages"] as const;

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Build `<workDir>/data/` with junction links to the archive roots found in
 * `dataRoot` (falling back to `engineDir` for roots the install lacks, e.g.
 * `base/` shipped inside the engine zip). Overwrites the staging dir from a
 * previous run. Returns the staging dir to pass as SPRING_DATADIR.
 */
export function stageDataDir(opts: {
  dataRoot: string;
  workDir: string;
  engineDir?: string;
  log?: Logger;
}): string {
  const { dataRoot, engineDir, log } = opts;
  const staging = path.join(opts.workDir, "data");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  const linkType = process.platform === "win32" ? "junction" : "dir";
  let linked = 0;
  for (const root of ARCHIVE_ROOTS) {
    const fromData = path.join(dataRoot, root);
    const fromEngine = engineDir !== undefined ? path.join(engineDir, root) : undefined;
    if (isDir(fromData)) {
      symlinkSync(fromData, path.join(staging, root), linkType);
      log?.info(`staged ${root}/ <- ${fromData}`);
      linked++;
    } else if (fromEngine !== undefined && isDir(fromEngine)) {
      symlinkSync(fromEngine, path.join(staging, root), linkType);
      log?.info(`staged ${root}/ <- ${fromEngine}`);
      linked++;
    }
  }
  if (linked === 0) {
    throw new Error(
      `no archive roots (maps/games/base/packages) found under ${dataRoot}` +
        (engineDir !== undefined ? ` or ${engineDir}` : ""),
    );
  }

  // Marker files keep the engine from treating the staging dir as writable
  // game data and from writing logs/cache into the linked roots.
  writeFileSync(path.join(staging, ".zkr-staged"), new Uint8Array());
  const writeDir = path.join(opts.workDir, "engine-write");
  mkdirSync(writeDir, { recursive: true });
  return staging;
}
