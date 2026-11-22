/**
 * Demo stream parsing. Layout (see demofile.h):
 *   repeat { float modGameTime; u32 length; } + length bytes of one raw
 *   network message. Message framing per NetMessageTypes.h / BaseNetProtocol.cpp:
 *   - fixed-size messages: [u8 type][payload]
 *   - string/vector messages: [u8 type][u8 size][payload] (u16 size for some)
 *   - strings are null-terminated, no length prefix (RawPacket::operator<<)
 */
import type { DemoFileHeader } from "./header.js";
import { PLAYER_STAT_ELEM_SIZE, parsePlayerStat, type PlayerStatistics } from "./header.js";

export const enum NetMsg {
  KeyFrame = 1, NewFrame = 2, Quit = 3, StartPlaying = 4, SetPlayerNum = 5,
  PlayerName = 6, Chat = 7, RandSeed = 8, GameID = 9, PathChecksum = 10,
  Command = 11, Select = 12, Pause = 13, AICommand = 14, AICommands = 15,
  AIShare = 16, UserSpeed = 19, InternalSpeed = 20, CpuUsage = 21,
  DirectControl = 22, DcUpdate = 23, Share = 26, SetShare = 27,
  PlayerStat = 29, GameOver = 30, MapDraw = 32, SyncResponse = 33,
  SystemMsg = 35, StartPos = 36, PlayerInfo = 38, PlayerLeft = 39,
  GameStateDump = 46, LogMsg = 49, LuaMsg = 50, Team = 51, GameData = 52,
  Alliance = 53, CCommand = 54, TeamStat = 60, ClientData = 61,
  AttemptConnect = 65, RejectConnect = 66, AiCreated = 70,
  AiStateChanged = 71, RequestTeamStat = 72, CreateNewPlayer = 75,
  AiCommandTracked = 76, GameFrameProgress = 77, Ping = 78,
}

export interface StreamChunk {
  /** mod time (seconds) at which the chunk was meant to be processed */
  modGameTime: number;
  type: number;
  /** message bytes including the type byte (subarray into the stream) */
  raw: Uint8Array;
}

export interface ChatEvent { frame: number; modGameTime: number; from: number; dest: number; toAllies: boolean; text: string; }
export interface MapDrawEvent {
  frame: number; playerNum: number; command: "point" | "erase" | "line";
  fromLua: boolean; label?: string;
  x?: number; z?: number; x2?: number; z2?: number;
}
export interface PlayerNameEvent { frame: number; playerNum: number; name: string; }
export interface StartPosEvent { frame: number; playerNum: number; teamNum: number; ready: number; x: number; y: number; z: number; }
export interface GameOverEvent { frame: number; playerNum: number; winningAllyTeams: number[]; }
export interface PlayerLeftEvent { frame: number; playerNum: number; bIntended: number; }
export interface PauseEvent { frame: number; playerNum: number; paused: boolean; }
export interface TeamEvent { frame: number; playerNum: number; action: number; param: number; }

export interface DemoStreamResult {
  chunks: StreamChunk[];
  /** message-type byte -> count (the deterministic-command-stream summary) */
  counts: Record<number, number>;
  chat: ChatEvent[];
  mapDraws: MapDrawEvent[];
  playerNames: PlayerNameEvent[];
  startPositions: StartPosEvent[];
  gameOvers: GameOverEvent[];
  playerLefts: PlayerLeftEvent[];
  pauses: PauseEvent[];
  teamEvents: TeamEvent[];
  playerStats: (PlayerStatistics & { playerNum: number; frame: number })[];
  /** frame of the first STARTPLAYING netmsg — the play actually begins here
   *  (ZK games record the lobby/pick phase first; everything before this
   *  frame is pre-game). 0 when the demo has no explicit anchor. */
  startPlayingFrame: number;
  /** final modGameTime seen in the stream */
  lastModGameTime: number;
}

export function parseDemoStream(
  streamBuf: Uint8Array,
  header: DemoFileHeader,
  opts: { startIndex?: number; keepChunks?: boolean } = {},
): DemoStreamResult {
  const keepChunks = opts.keepChunks ?? true;
  const res: DemoStreamResult = {
    chunks: [], counts: {}, chat: [], mapDraws: [], playerNames: [],
    startPositions: [], gameOvers: [], playerLefts: [], pauses: [],
    teamEvents: [], playerStats: [], lastModGameTime: 0,
    startPlayingFrame: 0,
  };
  const dv = new DataView(streamBuf.buffer, streamBuf.byteOffset, streamBuf.byteLength);
  const frameOf = (modGameTime: number) => Math.round(modGameTime * 30);
  let startPlayingSeen = false;
  let pos = opts.startIndex ?? 0;
  const end = Math.min(pos + header.demoStreamSize, streamBuf.byteLength);

  while (pos + 8 <= end) {
    const modGameTime = dv.getFloat32(pos, true);
    const length = dv.getUint32(pos + 4, true);
    pos += 8;
    if (length > end - pos) break; // truncated file
    const raw = streamBuf.subarray(pos, pos + length);
    pos += length;
    res.lastModGameTime = modGameTime;

    const type = raw[0] ?? 0;
    if (keepChunks) res.chunks.push({ modGameTime, type, raw });
    res.counts[type] = (res.counts[type] ?? 0) + 1;
    const frame = frameOf(modGameTime);

    switch (type) {
      case NetMsg.StartPlaying: {
        // [type][u32 countdown ms] — the epoch where the engine's sim clock
        // (GameFrame 0) begins is the LATEST startplaying candidate: ZK
        // first records a variant carrying a countdown (e.g. 4000 ms), then
        // the final one with 0. Play-relative resim frames align to that
        // epoch, so the anchor must be the max candidate, not the first event.
        const countdownFrames = raw.length >= 5
          ? Math.round(dvOf(raw).getUint32(1, true) * 30 / 1000)
          : 0;
        const candidate = frame + countdownFrames;
        if (!startPlayingSeen || candidate > res.startPlayingFrame) {
          res.startPlayingFrame = candidate;
          startPlayingSeen = true;
        }
        break;
      }
      case NetMsg.Chat: {
        // [type][size][from u8][dest u8][text\0]
        if (raw.length < 4) break;
        const from = raw[2]!, dest = raw[3]!;
        res.chat.push({
          frame, modGameTime, from, dest,
          toAllies: dest !== 126 && dest !== 0,
          text: readCString(raw, 4),
        });
        break;
      }
      case NetMsg.PlayerName: {
        // [type][size][playerNum u8][name\0]
        if (raw.length < 4) break;
        res.playerNames.push({ frame, playerNum: raw[2]!, name: readCString(raw, 3) });
        break;
      }
      case NetMsg.StartPos: {
        // fixed 16: [type][playerNum][teamNum][ready][float x y z]
        if (raw.length < 16) break;
        const d2 = dvOf(raw);
        res.startPositions.push({
          frame, playerNum: raw[1]!, teamNum: raw[2]!, ready: raw[3]!,
          x: d2.getFloat32(4, true), y: d2.getFloat32(8, true), z: d2.getFloat32(12, true),
        });
        break;
      }
      case NetMsg.GameOver: {
        // [type][size][playerNum u8][winningAllyTeams bytes]
        if (raw.length < 3) break;
        res.gameOvers.push({ frame, playerNum: raw[2]!, winningAllyTeams: Array.from(raw.subarray(3)) });
        break;
      }
      case NetMsg.PlayerLeft: {
        if (raw.length < 3) break;
        res.playerLefts.push({ frame, playerNum: raw[1]!, bIntended: raw[2]! });
        break;
      }
      case NetMsg.Pause: {
        if (raw.length < 3) break;
        res.pauses.push({ frame, playerNum: raw[1]!, paused: raw[2]! === 1 });
        break;
      }
      case NetMsg.Team: {
        if (raw.length < 4) break;
        res.teamEvents.push({ frame, playerNum: raw[1]!, action: raw[2]!, param: raw[3]! });
        break;
      }
      case NetMsg.PlayerStat: {
        // [type][playerNum][5x i32 stats] — fixed 22 bytes, no size byte
        if (raw.length < 2 + PLAYER_STAT_ELEM_SIZE) break;
        res.playerStats.push({ playerNum: raw[1]!, frame, ...parsePlayerStat(raw, 2) });
        break;
      }
      case NetMsg.MapDraw: {
        // [type][size][playerNum][drawType]…
        if (raw.length < 4) break;
        const drawType = raw[3]!;
        const cmd: "point" | "erase" | "line" = drawType === 0 ? "point" : drawType === 1 ? "erase" : "line";
        const ev: MapDrawEvent = { frame, playerNum: raw[2]!, command: cmd, fromLua: false };
        const d2 = dvOf(raw);
        if (cmd === "erase" && raw.length >= 12) {
          ev.x = d2.getUint32(4, true); ev.z = d2.getUint32(8, true);
        } else if (cmd === "line" && raw.length >= 21) {
          ev.x = d2.getUint32(4, true); ev.z = d2.getUint32(8, true);
          ev.x2 = d2.getUint32(12, true); ev.z2 = d2.getUint32(16, true);
          ev.fromLua = raw[20] !== 0;
        } else if (cmd === "point" && raw.length >= 14) {
          ev.x = d2.getUint32(4, true); ev.z = d2.getUint32(8, true);
          ev.fromLua = raw[12] !== 0;
          ev.label = readCString(raw, 13);
        }
        res.mapDraws.push(ev);
        break;
      }
      default:
        break;
    }
  }
  return res;
}

function readCString(buf: Uint8Array, start: number): string {
  let end = start;
  while (end < buf.length && buf[end] !== 0) end++;
  return new TextDecoder().decode(buf.subarray(start, end));
}

function dvOf(raw: Uint8Array): DataView {
  return new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
}
