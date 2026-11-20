/**
 * Event model for `ZKR <json>` lines emitted by the snapshot widget on engine
 * stdout during the headless resim, and the accumulator that turns the line
 * stream into structured replay data (spec §§A–C, §L).
 */
import type { WeaponDefInfo } from "./classify.js";

/** How the packer classifies/renders a projectile. */
export const ProjClass = {
  /** not recorded at all (bombs, melee, shields, lightning, torpedoes off) */
  DROPPED: 0,
  /** origin -> impact line */
  BEAM: 1,
  /** full 8 Hz arc */
  ARTILLERY: 2,
  /** full 8 Hz trajectory + signature blast */
  NUKE: 3,
  /** full 8 Hz trajectory */
  MISSILE: 4,
  /** launch + interception events only (anti-nuke etc.) */
  INTERCEPTOR: 5,
} as const;
export type ProjClassValue = (typeof ProjClass)[keyof typeof ProjClass];

export interface UnitDefInfo {
  defID: number;
  name: string;
  metalCost?: number;
  health?: number;
  /** UnitDefs.canMove — false marks structures (fixed-size render) */
  canMove?: boolean;
  /** UnitDefs.iconType — unit icon key for the viewer */
  iconType?: string;
  /** UnitDefs.humanName — display name for the viewer (e.g. cloakraid → Glaive) */
  humanName?: string;
}

export interface PosSample {
  frame: number;
  x: number;
  z: number;
  /** 0..255 fraction, or undefined when unknown */
  hp?: number | undefined;
  /** 0..255 build progress fraction */
  build?: number | undefined;
}

export interface UnitTrack {
  unitID: number;
  defID: number;
  name?: string;
  team?: number;
  samples: PosSample[];
}

export type EventKind = "spawn" | "death" | "finished" | "transfer" | "gameover";

export interface EvntRecord {
  kind: EventKind;
  frame: number;
  unitID: number;
  /** meaning depends on kind (spawn: defID; death: killer unitID) */
  int1: number;
  /** death: killer team; spawn: team */
  int2: number;
  /** death: weaponDefID */
  int3: number;
}

export interface ProjTrack {
  proID: number;
  weaponDefID: number;
  ownerTeam: number;
  samples: Array<{ frame: number; x: number; y: number; z: number }>;
}

export interface LinkRecord {
  djinnID: number;
  lampID: number;
  team: number;
  openFrame: number;
  /** undefined while the link is open */
  closeFrame?: number | undefined;
  lampX?: number | undefined;
  lampZ?: number | undefined;
}

export interface StartboxData {
  /** allyteam -> box id assignments (box ids key into boxes) */
  allyBox: Array<[number, number]>;
  /** box id -> polygons (each polygon an array of [x, z] normalized 0..1) */
  boxes: Map<number, number[][][]>;
}

export interface SnapshotData {
  meta: { mapW?: number; mapH?: number; engine?: string; gameVersion?: string };
  units: Map<number, UnitTrack>;
  events: EvntRecord[];
  projectiles: Map<number, ProjTrack>;
  links: Map<number, LinkRecord>;
  unitDefs: Map<number, UnitDefInfo>;
  weaponDefs: Map<number, WeaponDefInfo>;
  gameOvers: Array<{ frame: number; winners: number[] }>;
  startboxes?: StartboxData;
}

export function newSnapshot(): SnapshotData {
  return {
    meta: {},
    units: new Map(),
    events: [],
    projectiles: new Map(),
    links: new Map(),
    unitDefs: new Map(),
    weaponDefs: new Map(),
    gameOvers: [],
  };
}

const LINK_PAIR = { djinn: "amphtele", lamp: "tele_beacon" } as const;
const LINK_OPEN_SENTINEL = 0xffffffff;

function num(v: unknown, fallback = -1): number {
  if (v === null || v === undefined) return fallback;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function frac(v: unknown): number | undefined {
  const n = num(v, -1);
  if (n < 0) return undefined;
  return Math.max(0, Math.min(255, Math.round(n * 255)));
}

export interface IngestResult {
  /** false when the line is not a ZKR line */
  isZkr: boolean;
  /** true when the line was a ZKR line AND parsed cleanly */
  ok: boolean;
}

/**
 * Feed one captured stdout line. The engine prefixes log output on stdout with
 * `[t=...][f=...]`, so `ZKR ` is located after that prefix rather than matched
 * at line start; non-ZKR lines are ignored (engine chatter).
 */
export function ingestLine(snap: SnapshotData, line: string): IngestResult {
  const idx = line.indexOf("ZKR {");
  if (idx === -1) return { isZkr: false, ok: false };
  try {
    ingestEvent(snap, JSON.parse(line.slice(idx + 4)) as Record<string, unknown>);
    return { isZkr: true, ok: true };
  } catch {
    return { isZkr: true, ok: false };
  }
}

export function ingestEvent(snap: SnapshotData, ev: Record<string, unknown>): void {
  switch (ev["t"]) {
    case "meta": {
      if (ev["w"] !== undefined) snap.meta.mapW = num(ev["w"], 0);
      if (ev["h"] !== undefined) snap.meta.mapH = num(ev["h"], 0);
      if (typeof ev["engine"] === "string") snap.meta.engine = ev["engine"];
      if (typeof ev["game"] === "string") snap.meta.gameVersion = ev["game"];
      return;
    }
    case "udef": {
      const defID = num(ev["d"]);
      snap.unitDefs.set(defID, {
        defID,
        name: String(ev["n"] ?? ""),
        metalCost: ev["m"] !== undefined ? num(ev["m"]) : undefined,
        health: ev["hp"] !== undefined ? num(ev["hp"]) : undefined,
        canMove: ev["mv"] !== undefined ? num(ev["mv"]) === 1 : undefined,
        iconType: typeof ev["ic"] === "string" && ev["ic"] !== "" ? ev["ic"] : undefined,
        humanName: typeof ev["hn"] === "string" && ev["hn"] !== "" ? ev["hn"] : undefined,
      });
      return;
    }
    case "wdef": {
      const defID = num(ev["d"]);
      snap.weaponDefs.set(defID, {
        defID,
        name: String(ev["n"] ?? ""),
        type: String(ev["w"] ?? ev["type"] ?? ""),
        range: ev["r"] !== undefined ? num(ev["r"]) : undefined,
        trajectoryHeight: ev["th"] !== undefined ? num(ev["th"]) : undefined,
        customParams: (ev["cp"] ?? undefined) as Record<string, string> | undefined,
      });
      return;
    }
    case "spawn": {
      const unitID = num(ev["u"]);
      const defID = num(ev["d"]);
      const name = typeof ev["n"] === "string" ? ev["n"] : undefined;
      const team = num(ev["tm"]);
      const builderID = num(ev["b"]);
      const frame = num(ev["f"], 0);
      let track = snap.units.get(unitID);
      if (!track) {
        track = { unitID, defID, name, team, samples: [] };
        snap.units.set(unitID, track);
      } else {
        if (name !== undefined) track.name = name;
        if (track.team === undefined) track.team = team;
      }
      snap.events.push({ kind: "spawn", frame, unitID, int1: defID, int2: team, int3: builderID });
      if (name === LINK_PAIR.lamp && builderID > 0) {
        const builder = snap.units.get(builderID);
        if (builder && (builder.name ?? snap.unitDefs.get(builder.defID)?.name) === LINK_PAIR.djinn) {
          snap.links.set(unitID, {
            djinnID: builderID,
            lampID: unitID,
            team,
            openFrame: frame,
            lampX: ev["x"] !== undefined && ev["x"] !== null ? num(ev["x"]) : undefined,
            lampZ: ev["z"] !== undefined && ev["z"] !== null ? num(ev["z"]) : undefined,
          });
        }
      }
      return;
    }
    case "pos": {
      const frame = num(ev["f"], 0);
      const rows = Array.isArray(ev["p"]) ? (ev["p"] as unknown[][]) : [];
      for (const row of rows) {
        const unitID = num(row[0]);
        const track = snap.units.get(unitID) ?? {
          unitID, defID: -1, samples: [] as PosSample[],
        };
        if (!snap.units.has(unitID)) snap.units.set(unitID, track);
        track.samples.push({
          frame,
          x: num(row[1], 0),
          z: num(row[2], 0),
          hp: frac(row[3]),
          build: frac(row[4]),
        });
      }
      return;
    }
    case "death": {
      const unitID = num(ev["u"]);
      snap.events.push({
        kind: "death",
        frame: num(ev["f"], 0),
        unitID,
        int1: num(ev["k"]),
        int2: num(ev["kt"]),
        int3: num(ev["w"]),
      });
      const link = snap.links.get(unitID);
      if (link && link.closeFrame === undefined) link.closeFrame = num(ev["f"], 0);
      return;
    }
    case "linkx": {
      const lampID = num(ev["lamp"]);
      const link = snap.links.get(lampID);
      if (link && link.closeFrame === undefined) link.closeFrame = num(ev["f"], 0);
      return;
    }
    case "proj": {
      const proID = num(ev["u"]);
      let track = snap.projectiles.get(proID);
      if (!track) {
        track = {
          proID,
          weaponDefID: num(ev["d"]),
          ownerTeam: num(ev["tm"]),
          samples: [],
        };
        snap.projectiles.set(proID, track);
      }
      track.samples.push({
        frame: num(ev["f"], 0),
        x: num(ev["x"], 0),
        y: num(ev["y"], 0),
        z: num(ev["z"], 0),
      });
      return;
    }
    case "gameover": {
      const winners = Array.isArray(ev["winners"]) ? (ev["winners"] as unknown[]).map((w) => num(w)) : [];
      snap.gameOvers.push({ frame: num(ev["f"], 0), winners });
      return;
    }
    case "sbx": {
      if (!snap.startboxes) snap.startboxes = { allyBox: [], boxes: new Map() };
      const data = snap.startboxes;
      if (ev["b"] && typeof ev["b"] === "object") {
        for (const [boxIDRaw, polysRaw] of Object.entries(ev["b"] as Record<string, unknown>)) {
          const boxID = Number(boxIDRaw);
          if (!Number.isFinite(boxID) || !Array.isArray(polysRaw)) continue;
          const polys = (polysRaw as unknown[])
            .filter((p): p is Array<Array<number>> => Array.isArray(p))
            .map((p) => p.map((v) => [num(v[0]), num(v[1])]));
          data.boxes.set(boxID, polys);
        }
      }
      if (ev["m"] && typeof ev["m"] === "object") {
        for (const [allyRaw, boxIDRaw] of Object.entries(ev["m"] as Record<string, unknown>)) {
          const ally = Number(allyRaw), boxID = num(boxIDRaw, -1);
          if (!Number.isFinite(ally) || ally < 0 || boxID < 0) continue;
          const existing = data.allyBox.find(([a]) => a === ally);
          if (existing) existing[1] = boxID;
          else data.allyBox.push([ally, boxID]);
        }
      }
      return;
    }
    default:
      return;
  }
}

export { LINK_OPEN_SENTINEL };
