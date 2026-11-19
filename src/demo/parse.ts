/**
 * Top-level .sdfz demo parsing: header → startscript → stream → winners →
 * player stats → team stats. Accepts raw gunzipped demo bytes.
 */
import {
  parseDemoHeader, parsePlayerStat, parseTeamStat,
  type DemoFileHeader, type PlayerStatistics, type TeamStatistics,
} from "./header.js";
import { parseStartscript, roster, type ParsedRosterPlayer, type StartscriptSection } from "./startscript.js";
import { parseDemoStream, type DemoStreamResult } from "./stream.js";

export interface ParsedDemo {
  header: DemoFileHeader;
  /** false if the host crashed while recording (demoStreamSize == 0) */
  complete: boolean;
  startscript: ReturnType<typeof parseStartscript>;
  roster: ReturnType<typeof roster>;
  stream: DemoStreamResult;
  /** header-order winners (allyTeam indices) */
  winners: number[];
  /** per header-parsed player slot, in demo order */
  playerStats: (PlayerStatistics & { index: number })[];
  /** teamNum -> stat history; empty when the host didn't record them */
  teamStats: Map<number, TeamStatistics[]>;
}

const TEAM_STAT_ELEM_SIZE = 80; // 20 little-endian words × 4 bytes

export interface ParseOptions {
  /** keep raw chunk list (needed for playback seek in M2); default false */
  keepChunks?: boolean;
}

export function parseDemo(demoBytes: Uint8Array, opts: ParseOptions = {}): ParsedDemo {
  const header = parseDemoHeader(demoBytes);
  let pos = header.headerSize;

  const scriptBuf = demoBytes.subarray(pos, pos + header.scriptSize);
  pos += header.scriptSize;
  const startscript = parseStartscript(new TextDecoder().decode(scriptBuf).replace(/\0+$/, ""));

  const streamBuf = demoBytes.subarray(pos);
  const streamEnd = header.demoStreamSize > 0
    ? Math.min(header.demoStreamSize, streamBuf.byteLength)
    : streamBuf.byteLength;
  const stream = parseDemoStream(streamBuf.subarray(0, streamEnd), header, {
    keepChunks: opts.keepChunks ?? false,
  });
  pos += streamEnd;
  const complete = header.demoStreamSize > 0;

  const winners: number[] = [];
  for (let i = 0; i < header.winningAllyTeamsSize && pos + i < demoBytes.byteLength; i++) {
    winners.push(demoBytes[pos + i]!);
  }
  pos += header.winningAllyTeamsSize;

  const playerStats: (PlayerStatistics & { index: number })[] = [];
  for (let i = 0; i < header.numPlayers && pos + header.playerStatElemSize <= demoBytes.byteLength; i++) {
    playerStats.push({ index: i, ...parsePlayerStat(demoBytes.subarray(pos, pos + header.playerStatElemSize)) });
    pos += header.playerStatElemSize;
  }

  const teamStats = new Map<number, TeamStatistics[]>();
  if (complete && pos + 4 * header.numTeams <= demoBytes.byteLength) {
    // counts array: numTeams × u32 (as written by DemoRecorder::WriteTeamStats)
    let cpos = pos;
    for (let team = 0; team < header.numTeams; team++) {
      const count = new DataView(demoBytes.buffer, demoBytes.byteOffset + cpos, 4).getUint32(0, true);
      cpos += 4;
      const hist: TeamStatistics[] = [];
      for (let k = 0; k < count && cpos + TEAM_STAT_ELEM_SIZE <= demoBytes.byteLength; k++) {
        hist.push(parseTeamStat(demoBytes.subarray(cpos, cpos + TEAM_STAT_ELEM_SIZE)));
        cpos += TEAM_STAT_ELEM_SIZE;
      }
      if (count > 0) teamStats.set(team, hist);
    }
  }

  return {
    header,
    complete,
    startscript,
    roster: roster(startscript),
    stream,
    winners,
    playerStats,
    teamStats,
  };
}

export type { DemoFileHeader, PlayerStatistics, TeamStatistics, ParsedRosterPlayer, StartscriptSection, DemoStreamResult };
export { parseDemoHeader, parsePlayerStat, parseTeamStat, parseStartscript, roster, parseDemoStream };
