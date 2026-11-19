/**
 * Isolated datadir staging for resim runs.
 *
 * The engine scans a fixed set of archive roots (`maps/`, `games/`,
 * `packages/`, plus Zero-K's `pool/` chunk store) inside each data dir.
 * Instead of pointing it at the host game folder directly -- where it could
 * write infolog.txt, cache/, or springsettings.cfg into the install -- we
 * build a private datadir under the daemon work dir and junction-link the
 * read-only archive roots into it. Engine writes are redirected to
 * `engine-write/` via SPRING_WRITEDIR, so the game install is only ever
 * read, never touched.
 *
 * `base/` is deliberately never staged: the engine always scans its own exe
 * dir as a datadir, and a second copy of `base/spring/*.sdz` through a
 * junction makes ArchiveScanner abort with "duplicate base content detected".
 */
import { mkdirSync, rmSync, writeFileSync, symlinkSync, statSync } from "node:fs";
import path from "node:path";
import type { Logger } from "./provision.js";

/** Archive roots to mirror into the staged datadir. `base/` is engine-owned. */
const ARCHIVE_ROOTS = ["maps", "games", "packages", "pool"] as const;

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Build `<workDir>/data/` with junction links to the archive roots found in
 * `dataRoot`. Overwrites the staging dir from a previous run. Returns the
 * staging dir (absolute when workDir is absolute) to pass as SPRING_DATADIR.
 */
export function stageDataDir(opts: {
  dataRoot: string;
  workDir: string;
  log?: Logger;
}): string {
  const { dataRoot, log } = opts;
  const staging = path.resolve(opts.workDir, "data");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  const linkType = process.platform === "win32" ? "junction" : "dir";
  let linked = 0;
  for (const root of ARCHIVE_ROOTS) {
    const fromData = path.join(dataRoot, root);
    if (isDir(fromData)) {
      symlinkSync(fromData, path.join(staging, root), linkType);
      log?.info(`staged ${root}/ <- ${fromData}`);
      linked++;
    }
  }
  if (linked === 0) {
    throw new Error(`no archive roots (maps/games/packages/pool) found under ${dataRoot}`);
  }

  // Marker file documents what produced this staging dir.
  writeFileSync(path.join(staging, ".zkr-staged"), new Uint8Array());
  return staging;
}
