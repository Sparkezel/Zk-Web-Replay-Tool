/**
 * Demo (.sdf/.sdfz) header — mirrors rts/System/LoadSave/demofile.h, DEMOFILE_VERSION 5.
 * All fields little-endian; total header size is 352 bytes.
 */
export const DEMOFILE_MAGIC = "spring demofile";
export const DEMOFILE_VERSION = 5;
export const DEMOFILE_HEADER_SIZE = 352;

export const PLAYER_STAT_ELEM_SIZE = 20; // numCommands, unitCommands, mousePixels, mouseClicks, keyPresses (i32 ×5)
export const TEAM_STAT_ELEM_SIZE = 80; // frame i32 + 12 floats + 7 i32
export const TEAM_STAT_PERIOD = 15; // seconds

export interface DemoFileHeader {
  version: number;
  headerSize: number;
  versionString: string;
  gameID: Uint8Array;
  unixTime: number;
  scriptSize: number;
  /** 0 => the host crashed while recording; stream extends to EOF and stats are missing */
  demoStreamSize: number;
  gameTime: number;
  wallclockTime: number;
  numPlayers: number;
  playerStatSize: number;
  playerStatElemSize: number;
  numTeams: number;
  teamStatSize: number;
  teamStatElemSize: number;
  teamStatPeriod: number;
  winningAllyTeamsSize: number;
}

function cleanString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).replace(/\0.*$/, "");
}

export function parseDemoHeader(buf: Uint8Array, offset = 0): DemoFileHeader {
  if (buf.length - offset < DEMOFILE_HEADER_SIZE) {
    throw new Error(`demo too small: ${buf.length - offset} bytes`);
  }
  const dv = new DataView(buf.buffer, buf.byteOffset + offset, DEMOFILE_HEADER_SIZE);
  const magic = cleanString(buf.subarray(offset, offset + 16));
  if (magic !== DEMOFILE_MAGIC) {
    throw new Error(`not a spring demofile, magic=${JSON.stringify(magic)}`);
  }
  let o = 16;
  const version = dv.getInt32(o, true); o += 4;
  const headerSize = dv.getInt32(o, true); o += 4;
  const versionString = cleanString(buf.subarray(offset + o, offset + o + 256)); o += 256;
  const gameID = buf.slice(offset + o, offset + o + 16); o += 16;
  const unixTime = Number(dv.getBigUint64(o, true)); o += 8;
  const ints: number[] = [];
  for (let i = 0; i < 12; i++) {
    ints.push(dv.getInt32(o, true));
    o += 4;
  }
  const [scriptSize, demoStreamSize, gameTime, wallclockTime, numPlayers,
    playerStatSize, playerStatElemSize, numTeams, teamStatSize, teamStatElemSize,
    teamStatPeriod, winningAllyTeamsSize] = ints;
  return {
    version, headerSize, versionString, gameID, unixTime,
    scriptSize, demoStreamSize, gameTime, wallclockTime,
    numPlayers, playerStatSize, playerStatElemSize,
    numTeams, teamStatSize, teamStatElemSize, teamStatPeriod,
    winningAllyTeamsSize,
  };
}

export interface PlayerStatistics {
  numCommands: number;
  unitCommands: number;
  mousePixels: number;
  mouseClicks: number;
  keyPresses: number;
}

const PLAYER_STAT_FIELDS = ["numCommands", "unitCommands", "mousePixels", "mouseClicks", "keyPresses"] as const;

export function parsePlayerStat(buf: Uint8Array, offset = 0): PlayerStatistics {
  const dv = new DataView(buf.buffer, buf.byteOffset + offset, PLAYER_STAT_ELEM_SIZE);
  const out = {} as Record<(typeof PLAYER_STAT_FIELDS)[number], number>;
  PLAYER_STAT_FIELDS.forEach((name, i) => {
    out[name] = dv.getInt32(i * 4, true);
  });
  return out;
}

export interface TeamStatistics {
  frame: number;
  metalUsed: number; energyUsed: number;
  metalProduced: number; energyProduced: number;
  metalExcess: number; energyExcess: number;
  metalReceived: number; energyReceived: number;
  metalSent: number; energySent: number;
  damageDealt: number; damageReceived: number;
  unitsProduced: number; unitsDied: number; unitsReceived: number;
  unitsSent: number; unitsCaptured: number; unitsOutCaptured: number;
  unitsKilled: number;
}

const TEAM_STAT_FIELDS = [
  "frame",
  "metalUsed", "energyUsed", "metalProduced", "energyProduced",
  "metalExcess", "energyExcess", "metalReceived", "energyReceived",
  "metalSent", "energySent", "damageDealt", "damageReceived",
  "unitsProduced", "unitsDied", "unitsReceived", "unitsSent",
  "unitsCaptured", "unitsOutCaptured", "unitsKilled",
] as const;

export function parseTeamStat(buf: Uint8Array, offset = 0): TeamStatistics {
  const dv = new DataView(buf.buffer, buf.byteOffset + offset, TEAM_STAT_ELEM_SIZE);
  const out = {} as Record<(typeof TEAM_STAT_FIELDS)[number], number>;
  TEAM_STAT_FIELDS.forEach((name, i) => {
    out[name] = i < 13
      ? (i === 0 ? dv.getInt32(0, true) : dv.getFloat32(i * 4, true))
      : dv.getInt32(i * 4, true);
  });
  return out;
}
