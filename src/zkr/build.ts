/**
 * Builds `.zkr` v1 artifacts from a cheap-parsed demo (M1 sections: META,
 * ROSTER, CHAT, DRAW, MACR, ECO, PSTA). POS/EVNT/PROJ/LINK arrive with the
 * M2 resim and share the same generic binary encoders defined here.
 */
import { SECTION, writeZkr, type SectionInput } from "./container.js";
import type { ParsedDemo } from "../demo/parse.js";

export function buildMetaSection(demo: ParsedDemo): Uint8Array {
  const h = demo.header;
  const meta = {
    schema: 1,
    gameID: hex(h.gameID),
    engine: h.versionString,
    gameVersion: demo.roster.gameType ?? "",
    map: { name: demo.roster.mapName ?? "", dims: null },
    unixTime: h.unixTime,
    gameTime: h.gameTime,
    wallclockTime: h.wallclockTime,
    demoStreamSize: h.demoStreamSize,
    complete: demo.complete,
    winners: demo.winners,
    endCondition: demo.stream.gameOvers.length > 0 ? "gameover" : demo.stream.pauses.some(() => true) ? "unknown" : "quit",
    lastModGameTime: demo.stream.lastModGameTime,
  };
  return utf8(JSON.stringify(meta));
}

export function buildRosterSection(demo: ParsedDemo): Uint8Array {
  const r = demo.roster;
  const out = {
    players: r.players.map((p) => ({
      name: p.name, elo: p.elo, level: p.level, team: p.team,
      spectator: p.spectator, country: p.countrycode, clan: p.clan,
      faction: p.faction, admin: p.admin, script: p.key,
    })),
    allyteams: r.allyteams,
    teams: r.teams,
    modoptions: r.modoptions ?? {},
    mapoptions: r.mapoptions ?? {},
  };
  return utf8(JSON.stringify(out));
}

export function buildChatSection(demo: ParsedDemo): Uint8Array {
  const rows = demo.stream.chat.map((c) => [c.frame, c.from, c.dest, c.text]);
  return utf8(JSON.stringify(rows));
}

export function buildMapDrawSection(demo: ParsedDemo): Uint8Array {
  const rows = demo.stream.mapDraws.map((d) => [d.frame, d.playerNum, d.command, d.x ?? -1, d.z ?? -1, d.x2 ?? -1, d.z2 ?? -1, d.fromLua ? 1 : 0, d.label ?? ""]);
  return utf8(JSON.stringify(rows));
}

export function buildMacroSection(demo: ParsedDemo): Uint8Array {
  const s = demo.stream;
  const out = {
    gameOvers: s.gameOvers.map((g) => ({ frame: g.frame, playerNum: g.playerNum, winners: g.winningAllyTeams })),
    playerLefts: s.playerLefts.map((p) => ({ frame: p.frame, playerNum: p.playerNum, bIntended: p.bIntended })),
    pauses: s.pauses.map((p) => ({ frame: p.frame, playerNum: p.playerNum, paused: p.paused })),
    teamEvents: s.teamEvents.map((t) => ({ frame: t.frame, playerNum: t.playerNum, action: t.action, param: t.param })),
    startPositions: s.startPositions.map((p) => ({ frame: p.frame, playerNum: p.playerNum, teamNum: p.teamNum, ready: p.ready, x: p.x, y: p.y, z: p.z })),
    playerNames: s.playerNames.map((p) => ({ frame: p.frame, playerNum: p.playerNum, name: p.name })),
    counts: Object.fromEntries(Object.entries(s.counts).map(([k, v]) => [NETMSG_NAME[Number(k)] ?? `type_${k}`, v])),
  };
  return utf8(JSON.stringify(out));
}

export function buildEcoSection(demo: ParsedDemo): Uint8Array {
  const teams: Array<{ team: number; stats: Array<Record<string, number>> }> = [];
  for (const [team, hist] of demo.teamStats) {
    teams.push({
      team,
      stats: hist.map((t) => ({
        frame: t.frame, metalProduced: t.metalProduced, energyProduced: t.energyProduced,
        metalUsed: t.metalUsed, energyUsed: t.energyUsed,
        damageDealt: t.damageDealt, damageReceived: t.damageReceived,
        unitsDied: t.unitsDied, unitsKilled: t.unitsKilled,
      })),
    });
  }
  return utf8(JSON.stringify({ teams, period: demo.header.teamStatPeriod }));
}

export function buildPlayerStatsSection(demo: ParsedDemo): Uint8Array {
  return utf8(JSON.stringify(demo.playerStats));
}

export interface BuildOptions {
  /** deflate sections (default true; raw only for tests) */
  deflate?: boolean;
}

export function buildZkrFromDemo(demo: ParsedDemo, opts: BuildOptions = {}): Uint8Array {
  const codec = opts.deflate === false ? 0 : 1;
  const secs: SectionInput[] = [
    { id: SECTION.META, version: 1, payload: buildMetaSection(demo), codec },
    { id: SECTION.ROSTER, version: 1, payload: buildRosterSection(demo), codec },
    { id: SECTION.PLAYERSTATS, version: 1, payload: buildPlayerStatsSection(demo), codec },
    { id: SECTION.ECO, version: 1, payload: buildEcoSection(demo), codec },
    { id: SECTION.MACRO, version: 1, payload: buildMacroSection(demo), codec },
    { id: SECTION.CHAT, version: 1, payload: buildChatSection(demo), codec },
    { id: SECTION.MAPDRAW, version: 1, payload: buildMapDrawSection(demo), codec },
  ];
  return writeZkr(secs);
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export const NETMSG_NAME: Record<number, string> = {
  1: "KEYFRAME", 2: "NEWFRAME", 3: "QUIT", 4: "STARTPLAYING", 5: "SETPLAYERNUM",
  6: "PLAYERNAME", 7: "CHAT", 8: "RANDSEED", 9: "GAMEID", 10: "PATH_CHECKSUM",
  11: "COMMAND", 12: "SELECT", 13: "PAUSE", 14: "AICOMMAND", 15: "AICOMMANDS",
  16: "AISHARE", 19: "USER_SPEED", 20: "INTERNAL_SPEED", 21: "CPU_USAGE",
  22: "DIRECT_CONTROL", 23: "DC_UPDATE", 26: "SHARE", 27: "SETSHARE",
  29: "PLAYERSTAT", 30: "GAMEOVER", 32: "MAPDRAW", 33: "SYNCRESPONSE",
  35: "SYSTEMMSG", 36: "STARTPOS", 38: "PLAYERINFO", 39: "PLAYERLEFT",
  46: "GAMESTATE_DUMP", 49: "LOGMSG", 50: "LUAMSG", 51: "TEAM", 52: "GAMEDATA",
  53: "ALLIANCE", 54: "CCOMMAND", 60: "TEAMSTAT", 61: "CLIENTDATA",
  65: "ATTEMPTCONNECT", 66: "REJECT_CONNECT", 70: "AI_CREATED",
  71: "AI_STATE_CHANGED", 72: "REQUEST_TEAMSTAT", 75: "CREATE_NEWPLAYER",
  76: "AICOMMAND_TRACKED", 77: "GAME_FRAME_PROGRESS", 78: "PING",
};
