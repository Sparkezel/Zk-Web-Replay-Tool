/**
 * Projectile classifier — spec §C revised policy.
 *
 * Buckets: dropped (not recorded), beam lines (origin->impact), artillery
 * arcs (full trajectory), missile paths (full trajectory; nukes flagged),
 * interceptor events (launch + interception only). Junk weapons by name are
 * always dropped.
 */

export interface WeaponDefInfo {
  defID?: number;
  name?: string;
  /** engine weaponType string, e.g. "Cannon", "BeamLaser", "AircraftBomb" */
  type?: string;
  range?: number;
  trajectoryHeight?: number;
  customParams?: Record<string, string>;
}

export const PROJ_CLASS_NAMES = ["dropped", "beam", "artillery", "nuke", "missile", "interceptor"] as const;

/** Beam line threshold (elmo); spec §C. */
const BEAM_MIN_RANGE = 900;
/** Artillery arc thresholds (elmo); spec §C. */
const ARTY_MIN_RANGE = 1000;
const ARTY_LOBED_MIN_RANGE = 800;
/** Missile path threshold (elmo); spec §C. */
const MISSILE_MIN_RANGE = 900;

/** Weapon types that never get a path or line (dropped bucket). */
const DROPPED_TYPES = new Set([
  "AircraftBomb", "Melee", "Shield", "LightningCannon", "TorpedoLauncher",
]);

/** Name substrings of junk / fake weapons (dropped bucket). */
const DROPPED_NAME_PATTERNS = [
  "fake", "bogus", "party", "anl_fake", "tele_beacon_target",
] as const;

/** Launcher types producing guided missile trajectories. */
const MISSILE_TYPES = new Set(["StarburstLauncher", "MissileLauncher"]);
/** Cannon type producing ballistic arcs. */
const ARTY_TYPES = new Set(["Cannon"]);
/** Beam types rendered as origin->impact lines. */
const BEAM_TYPES = new Set(["BeamLaser", "LaserCannon"]);

export function classifyProjectile(w: WeaponDefInfo): number {
  const name = (w.name ?? "").toLowerCase();
  if (DROPPED_NAME_PATTERNS.some((p) => name.includes(p))) return 0;

  const type = w.type ?? "";
  if (DROPPED_TYPES.has(type)) return 0;

  const range = w.range ?? 0;
  const trajectoryHeight = w.trajectoryHeight ?? 0;

  if (w.customParams?.["interceptor"] === "1") return 5;

  if (type === "StarburstLauncher" || (type === "MissileLauncher" && (name.includes("nuke") || w.customParams?.["isnuke"] === "1"))) {
    return name.includes("nuke") || w.customParams?.["isnuke"] === "1" ? 3 : 4;
  }
  if (MISSILE_TYPES.has(type) && range >= MISSILE_MIN_RANGE) {
    return name.includes("nuke") || w.customParams?.["isnuke"] === "1" ? 3 : 4;
  }

  if (BEAM_TYPES.has(type) && range >= BEAM_MIN_RANGE) return 1;

  if (ARTY_TYPES.has(type) && (range >= ARTY_MIN_RANGE || (trajectoryHeight > 0 && range >= ARTY_LOBED_MIN_RANGE))) {
    return 2;
  }

  return 0;
}

/** Packer projectile presets — spec §C `--projectiles`. */
export type ProjectilePreset = "none" | "beams" | "heavy" | "all";

const PRESET_CLASSES: Record<ProjectilePreset, ReadonlySet<number>> = {
  none: new Set([]),
  beams: new Set([1]),
  heavy: new Set([1, 2, 3, 4, 5]),
  all: new Set([0, 1, 2, 3, 4, 5]),
};

/** Whether a projectile of `cls` is recorded under `preset`. */
export function presetRecords(preset: ProjectilePreset, cls: number): boolean {
  return PRESET_CLASSES[preset].has(cls);
}
