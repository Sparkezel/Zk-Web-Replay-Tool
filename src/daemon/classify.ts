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
  /** explosion area of effect in elmos (gui_aoe override, then the engine's
   *  damageAreaOfEffect — the same precedence as ZK's attack-AoE widget) */
  aoe?: number;
  /** napalm ground patch radius in elmos (area damage weapons) */
  areaDamageRadius?: number;
  /** napalm ground patch duration in seconds */
  areaDamageDuration?: number;
  /** ZK's own napalm classification (description / lups fx), NOT merely
   *  area damage — slow fields and black holes are not fire */
  napalm?: boolean;
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

/** Weapon types that never get a path or line (dropped bucket).
 *  LightningCannon is NOT here: every lightning gun in ZK (Knight, Venom,
 *  Felon's Shield Gun, Paladin, Scorpion, the comm lightninggun module)
 *  is a short sharp arc worth showing — they classify as beams below
 *  regardless of range, so short ones like Venom's 240 or the Scorpion's
 *  490 do not fall through the 900-elmo beam gate. */
const DROPPED_TYPES = new Set([
  "AircraftBomb", "Melee", "Shield", "TorpedoLauncher",
]);

/** Name substrings of junk / fake weapons (dropped bucket). "party" was
 *  removed: no real weapon contains it except the LEGIT unit keys
 *  raveparty (Disco Rave Party), jumparty (Firewalker) and shiparty —
 *  the disco's colour cannons were silently dropped wholesale; the fake
 *  proxies are already covered by "fake"/"bogus". */
const DROPPED_NAME_PATTERNS = [
  "fake", "bogus", "anl_fake", "tele_beacon_target",
] as const;

/** Launcher types producing guided missile trajectories. */
const MISSILE_TYPES = new Set(["StarburstLauncher", "MissileLauncher"]);
/** Cannon type producing ballistic arcs. */
const ARTY_TYPES = new Set(["Cannon"]);
/** Beam types rendered as origin->impact lines. */
const BEAM_TYPES = new Set(["BeamLaser", "LaserCannon"]);

/** Named big-beam overrides (the fat purple laser set): Lance's Tachyon,
 *  Lucifer's beam, the Grizzly/Stinger lasers, the Paladin's laser and the
 *  Detriment's three lasers. Several sit under the 900-elmo beam gate
 *  (Grizzly r660, Detriment r550-820) and would otherwise be dropped;
 *  the recording is only the flight path — the fat purple look is a
 *  paint-time decision in the viewer. */
const BEAM_WEAPON_NAMES = new Set([
  "hoverarty_ata", "turretantiheavy_ata", "amphassault_laser",
  "turretheavylaser_laser", "striderbantha_ata", "striderdetriment_aalaser",
  "striderdetriment_trilaser", "striderdetriment_obliteration_blaster",
]);
/** Named "plain projectile" overrides: the Cyclops's main gun is a short
 *  flat Cannon (r450, no arc) which no generic rule can catch — recorded
 *  as artillery-class flights so it draws the normal yellow dash + blip.
 *  The Ogre's Banisher rockets (r320 MissileLauncher) same story, and they
 *  additionally carry an AoE the viewer paints as an impact ring. */
const ARC_WEAPON_NAMES = new Set(["tankheavyassault_cor_gol", "tankriot_tawf_banisher"]);

export function classifyProjectile(w: WeaponDefInfo): number {
  const name = (w.name ?? "").toLowerCase();

  // named overrides first - they are exact weapon names, more precise
  // than any type/range rule can ever be
  if (BEAM_WEAPON_NAMES.has(name)) return 1;
  if (ARC_WEAPON_NAMES.has(name)) return 2;

  // ground napalm (ZK's own classification: description / lups fx, not merely
  // any area damage) is recorded first regardless — ZK prefixes weapon names
  // with the unit key, so legit napalm weapons like the Firewalker's
  // `jumparty_napalm_sprayer` never depend on the name patterns.
  if (w.napalm) return 2;

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

  // lightning guns: beams at ANY range - the whole type is lightning
  // guns (see the DROPPED_TYPES comment)
  if (type === "LightningCannon") return 1;

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
