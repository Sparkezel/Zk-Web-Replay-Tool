/**
 * Parser for the Spring startscript embedded in demos (`[game]` Lua-table-ish
 * config: `[sectionName]` followed by `{`, assignments `key=value;`, close `}`).
 * Values may span multiple lines (e.g. `startboxes=return { ... };`) and may
 * contain `;` and `{}` inside the value text (only trailing `;` terminates).
 */
export type StartscriptValue = string;
export interface StartscriptSection {
  [key: string]: StartscriptValue | StartscriptSection | undefined;
  name?: undefined;
}
export interface ParsedStartscript {
  sections: Record<string, StartscriptSection[]>;
  /** first top-level `game` section's flat lookup */
  root: StartscriptSection;
  /** original script text (for the engine during resim) */
  raw: string;
}

export function parseStartscript(text: string): ParsedStartscript {
  const root: StartscriptSection = {};
  const sections: Record<string, StartscriptSection[]> = {};
  const stack: Array<{ key: string; section: StartscriptSection }> = [];
  let pending: { key: string } | null = null;
  let pendingValue = "";

  const strip = (s: string) => s.trim().replace(/;$/, "").trim();

  const assign = (line: string, target: StartscriptSection) => {
    const eq = line.indexOf("=");
    if (eq < 0) return;
    const key = line.slice(0, eq).trim();
    const value = strip(line.slice(eq + 1));
    target[key] = value;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("//") || line.startsWith("#")) continue;

    if (pending) {
      pendingValue += "\n" + rawLine;
      if (line.endsWith(";")) {
        const target = stack.length ? stack[stack.length - 1]!.section : root;
        target[pending.key] = strip(pendingValue);
        pending = null;
      }
      continue;
    }

    if (line.startsWith("[") && line.endsWith("]")) {
      const name = line.slice(1, -1);
      const section: StartscriptSection = {};
      (sections[name] = sections[name] ?? []).push(section);
      // remember until the following `{`
      stack.push({ key: name, section });
      continue;
    }
    if (line === "{") {
      if (stack.length > 0) {
        const top = stack[stack.length - 1]!;
        // the section body is written into the section object stored in the
        // parent; re-parent it properly
        const parent = stack.length >= 2 ? stack[stack.length - 2]!.section : root;
        parent[top.key] = top.section;
      }
      continue;
    }
    if (line === "}") {
      stack.pop();
      continue;
    }
    if (line.endsWith(";")) {
      const target = stack.length ? stack[stack.length - 1]!.section : root;
      assign(line, target);
    } else if (line.includes("=")) {
      const eq = line.indexOf("=");
      pending = { key: line.slice(0, eq).trim() };
      pendingValue = line.slice(eq + 1);
    }
  }

  return { sections, root, raw: text };
}

export interface ParsedRosterPlayer {
  key: string;
  name: string;
  elo?: number;
  level?: number;
  team?: number;
  spectator: boolean;
  countrycode?: string;
  clan?: string;
  faction?: string;
  admin: boolean;
  /* attached section index, e.g. player0 -> 0 */
  index: number;
}

export function roster(script: ParsedStartscript): {
  players: ParsedRosterPlayer[];
  allyteams: Array<{ numallies?: number; startboxes?: string }>;
  mapName?: string;
  gameType?: string;
  modoptions?: StartscriptSection;
  mapoptions?: StartscriptSection;
} {
  // everything in actual startscripts lives inside the `[game]` section
  const game: StartscriptSection = script.sections["game"]?.[0] ?? script.root;
  const players = Object.entries(script.sections)
    .filter(([k]) => k.toLowerCase().startsWith("player"))
    .flatMap(([k, list]) => list.map((s, i) => {
      return {
        key: k,
        index: i,
        name: String(s["name"] ?? ""),
        elo: s["elo"] !== undefined ? Number(s["elo"]) : undefined,
        level: s["level"] !== undefined ? Number(s["level"]) : undefined,
        team: s["team"] !== undefined ? Number(s["team"]) : undefined,
        spectator: String(s["spectator"] ?? "0") !== "0",
        countrycode: asOpt(s, "countrycode"),
        clan: asOpt(s, "clan"),
        faction: asOpt(s, "faction"),
        admin: String(s["admin"] ?? "0") !== "0",
      };
    }));
  const allyteams = Object.entries(script.sections)
    .filter(([k]) => k.toLowerCase().startsWith("allyteam"))
    .flatMap(([, list]) => list.map((s) => ({
      numallies: s["numallies"] !== undefined ? Number(s["numallies"]) : undefined,
      startboxes: asOpt(s, "startboxes"),
    })));
  return {
    players: players.sort((a, b) => a.key.localeCompare(b.key)),
    allyteams,
    mapName: opt(game["mapname"]),
    gameType: opt(game["gametype"]),
    modoptions: script.sections["modoptions"]?.[0],
    mapoptions: script.sections["mapoptions"]?.[0],
  };
}

function asOpt(section: StartscriptSection, key: string): string | undefined {
  const v = section[key];
  if (v === undefined || typeof v !== "string") return undefined;
  const cleaned = v.replace(/;$/, "").trim();
  return cleaned === "" ? undefined : cleaned;
}
function opt(v: StartscriptValue | StartscriptSection | undefined): string | undefined {
  return typeof v === "string" ? v.replace(/;$/, "").trim() : undefined;
}
