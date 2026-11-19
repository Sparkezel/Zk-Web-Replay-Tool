/**
 * Remote resource locations for the resim daemon.
 *
 * Engine zips are published per version by the Zero-K project at
 * `zero-k.info/engine/<platform>/<version>.zip`; demos are downloadable from
 * the battle page. Game data (mod + map archives) comes from the rapid
 * repositories at repos.springrts.com via pr-downloader.
 */

export type EnginePlatform = "win64" | "win32" | "linux64" | "linux32";

export function engineZipUrl(version: string, platform: EnginePlatform = "win64"): string {
  return `https://zero-k.info/engine/${platform}/${version}.zip`;
}

/** Battle-detail page for a lobby battle ID. */
export function battleDetailUrl(battleID: string): string {
  return `https://zero-k.info/Battles/Detail/${battleID}`;
}

/** Direct `.sdfz` download for a lobby battle ID. */
export function demoUrl(battleID: string): string {
  return `https://zero-k.info/Battles/Download/${battleID}`;
}

/** Rapid repository tag holding the Zero-K game data (mod + dependencies). */
export const RAPID_REPO_ZK = "zk:stable";

/** pr-downloader invocation that syncs the game data into `--rapid-dir`. */
export function prDownloaderArgs(rapidDir: string, repo: string = RAPID_REPO_ZK): string[] {
  return ["--fsa", repo, "--dir", rapidDir];
}

/** Headless engine binary names per platform. */
export const HEADLESS_BINARY: Record<string, string> = {
  win32: "spring-headless.exe",
  linux: "spring-headless",
  darwin: "spring-headless",
};
