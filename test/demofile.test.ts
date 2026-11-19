/**
 * Builds a small synthetic (but structurally faithful) .sdfz in-memory and
 * checks the full pipeline: header → startscript → stream → stats → .zkr
 * roundtrip. Also parses a trimmed real-world startscript excerpt.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  parseDemo, parseStartscript, roster, buildZkrFromDemo, readZkr, SECTION,
} from "../dist/index.js";
import { DEMOFILE_MAGIC, DEMOFILE_HEADER_SIZE } from "../dist/demo/header.js";

const STARTSCRIPT_EXCERPT = `[game]
{
[player0]
{
elo=2622;
level=105;
name=SparkezelPL;
spectator=0;
team=7;
countrycode=BE;
commanders=ewogICJjNTc3ODgiLAogICJjOTAwMzUiCn0=;
admin=0;
}
[player1]
{
name=ninse;
elo=2608;
spectator=0;
team=4;
}
[allyteam0]
{
numallies=3;
}
[allyteam1]
{
numallies=3;
}
[modoptions]
{
startboxes=return { };
morespeed=0;
}
[team0]
{
allyteam=0;
teamleader=0;
handicap=0;
}
zksearchtag=fd7163b8-2b7c-4f57-b748-964bbdcad8f8;
ishost=1;
hostip=78.46.36.167;
maphash=1;
gametype=Zero-K v1.14.10.3;
mapname=Otago 1.4;
startpostype=2;
modhash=1;
showservername=[A] Teams All Welcome #1;
}
`;

interface Msg { bytes: Uint8Array; modGameTime: number }
/* structural inventory of fixtures lives in buildToyDemo */
function u8(...v: number[]): Uint8Array { return Uint8Array.from(v); }



/** chat: [type][size][from][dest][text\0] */
function chat(modGameTime: number, from: number, dest: number, text: string): Msg {
  const payload = [from, dest] as number[];
  const bytes = Uint8Array.from([
    7, 2 + payload.length + text.length + 1, from, dest, ...new TextEncoder().encode(text), 0,
  ]);
  return { bytes, modGameTime };
}

/** gameover: [type][size][playerNum][winners...] */
function gameOver(modGameTime: number, playerNum: number, winners: number[]): Msg {
  const bytes = Uint8Array.from([30, 2 + 1 + winners.length, playerNum, ...winners]);
  return { bytes, modGameTime };
}

/** newframe: [type] (1 byte) */
function newFrame(modGameTime: number): Msg {
  return { bytes: u8(2), modGameTime };
}

/** keyframe: [type][i32 frame] */
function keyFrame(modGameTime: number, frameNum: number): Msg {
  const b = new Uint8Array(5);
  b[0] = 1;
  new DataView(b.buffer).setInt32(1, frameNum, true);
  return { bytes: b, modGameTime };
}

/** playerstat: [type][playerNum][5x i32] (22 bytes, unframed) */
function playerStat(modGameTime: number, playerNum: number, vals: number[]): Msg {
  const b = new Uint8Array(2 + 20);
  b[0] = 29; b[1] = playerNum;
  const dv = new DataView(b.buffer);
  vals.forEach((v, i) => dv.setInt32(2 + i * 4, v, true));
  return { bytes: b, modGameTime };
}

/** startpos: [type][playerNum][teamNum][ready][f32 x y z] (16 bytes) */
function startPos(modGameTime: number, playerNum: number, x: number): Msg {
  const b = new Uint8Array(16);
  b[0] = 36; b[1] = playerNum; b[2] = 0; b[3] = 1;
  const dv = new DataView(b.buffer);
  dv.setFloat32(4, x, true); dv.setFloat32(8, 0.25, true); dv.setFloat32(12, x, true);
  return { bytes: b, modGameTime };
}

function chunkStream(msgs: Msg[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const m of msgs) {
    const head = new Uint8Array(8);
    const dv = new DataView(head.buffer);
    dv.setFloat32(0, m.modGameTime, true);
    dv.setUint32(4, m.bytes.byteLength, true);
    parts.push(head, m.bytes);
  }
  const total = parts.reduce((a, p) => a + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

function buildToyDemo(): Uint8Array {
  const script = STARTSCRIPT_EXCERPT;
  const streamMsgs: Msg[] = [
    keyFrame(0, 0),
    newFrame(0.1),
    chat(5, 0, 126, "gl hf"),
    chat(20, 1, 125, "attack mid!"),
    startPos(24, 0, 0.2),
    playerStat(30, 0, [1234, 5678, 946129, 2340, 436]),
    playerStat(31, 1, [772, 9173, 650219, 2144, 416]),
    newFrame(60.0),
    gameOver(1516, 3, [0]),
  ];
  const stream = chunkStream(streamMsgs);
  const header = new Uint8Array(DEMOFILE_HEADER_SIZE);
  const dv = new DataView(header.buffer);
  header.set(new TextEncoder().encode(DEMOFILE_MAGIC), 0);
  dv.setInt32(16, 5, true);          // version
  dv.setInt32(20, DEMOFILE_HEADER_SIZE, true); // headerSize
  header.set(new TextEncoder().encode("2026.07.04"), 24);
  header.set(Uint8Array.from({ length: 16 }, (_, i) => (0x10 + i) & 0xff), 280); // gameID @ 24+256
  dv.setBigUint64(296, 1794745661n, true); // unixTime
  let o = 304;
  const setI = (v: number) => { dv.setInt32(o, v, true); o += 4; };
  setI(script.length);               // scriptSize
  setI(stream.byteLength);           // demoStreamSize
  setI(1516);                        // gameTime
  setI(1710);                        // wallclock
  setI(2);                           // numPlayers
  setI(2 * 20);                      // playerStatSize
  setI(20);                          // playerStatElemSize
  setI(2);                           // numTeams
  setI(8);                           // teamStatSize (counts only)
  setI(80);                          // teamStatElemSize
  setI(15);                          // teamStatPeriod
  setI(1);                           // winningAllyTeamsSize
  const winners = u8(0);
  const playerStats = new Uint8Array(2 * 20);
  const psDv = new DataView(playerStats.buffer);
  [[1234, 5678, 946129, 2340, 436], [772, 9173, 650219, 2144, 416]].forEach((vals, p) => {
    vals.forEach((v, i) => psDv.setInt32(p * 20 + i * 4, v, true));
  });
  const teamCounts = new Uint8Array(8); // all zero like real autohost demos
  const body = new Uint8Array(script.length + stream.byteLength + winners.byteLength + playerStats.byteLength + teamCounts.byteLength);
  let p = 0;
  for (const part of [new TextEncoder().encode(script), stream, winners, playerStats, teamCounts]) {
    body.set(part, p);
    p += part.byteLength;
  }
  const full = new Uint8Array(header.byteLength + body.byteLength);
  full.set(header, 0);
  full.set(body, header.byteLength);
  return gzipSync(full);
}

test("parse demo header + startscript + stream", () => {
  const demo = parseDemo(gunzip(buildToyDemo()));
  assert.equal(demo.header.version, 5);
  assert.equal(demo.header.versionString, "2026.07.04");
  assert.equal(demo.complete, true);
  assert.equal(demo.roster.mapName, "Otago 1.4");
  assert.equal(demo.roster.gameType, "Zero-K v1.14.10.3");
  assert.equal(demo.roster.players.length, 2);
  assert.equal(demo.roster.players[0]!.name, "SparkezelPL");
  assert.equal(demo.roster.players[0]!.elo, 2622);
  assert.equal(demo.roster.players[0]!.spectator, false);
  assert.equal(demo.roster.players[0]!.countrycode, "BE");
  assert.equal(demo.roster.modoptions?.["morespeed"], "0");
  assert.equal(demo.winners.length, 1);
  assert.equal(demo.winners[0], 0);
  assert.equal(demo.stream.chat.length, 2);
  assert.equal(demo.stream.chat[0]!.text, "gl hf");
  assert.equal(demo.stream.chat[1]!.dest, 125);
  assert.equal(demo.stream.gameOvers.length, 1);
  assert.deepEqual(demo.stream.gameOvers[0]!.winningAllyTeams, [0]);
  assert.equal(demo.stream.startPositions[0]!.x > 0, true);
  assert.equal(demo.playerStats.length, 2);
  assert.equal(demo.playerStats[0]!.numCommands, 1234);
  assert.equal(demo.playerStats[1]!.unitCommands, 9173);
  assert.equal(demo.teamStats.size, 0); // autohost didn't record team stats
  // message type counts sane
  assert.equal(demo.stream.counts[2], 2); // NEWFRAME
  assert.equal(demo.stream.counts[7], 2); // CHAT
  assert.equal(demo.stream.counts[30], 1); // GAMEOVER
});

test("startscript parser handles multi-line lua values", () => {
  const parsed = parseStartscript(`[game]
{
[modoptions]
{
startboxes=return {
  [1] = { [0] = {0.1,0.2,0.3,0.4} };
};
box=1;
}
}`);
  const mo = parsed.sections["modoptions"]![0]!;
  assert.match(String(mo["startboxes"]), /0\.1,0\.2/);
  assert.equal(mo["box"], "1");
});

test("roster helper extracts allyteams and startbox info", () => {
  const { roster: r } = { roster: roster(parseStartscript(STARTSCRIPT_EXCERPT)) };
  assert.equal(r.allyteams.length, 2);
  assert.equal(r.allyteams[0]!.numallies, 3);
});

test(".zkr roundtrip", () => {
  const demo = parseDemo(gunzip(buildToyDemo()));
  const zkr = buildZkrFromDemo(demo);
  assert.equal(zkr[0], 0x5a); // "Z"
  assert.equal(zkr[3], 1); // version
  const secs = readZkr(zkr);
  const ids = secs.map((s) => s.id).filter((s) => s === s.trim() || true);
  for (const expect of ["META", "ROST", "PSTA", "ECO ", "MACR", "CHAT", "DRAW"]) {
    assert.ok(ids.includes(expect), `missing section ${expect}`);
  }
  const meta = JSON.parse(new TextDecoder().decode(secs.find((s) => s.id === SECTION.META)!.payload));
  assert.equal(meta.winners.length, 1);
  assert.equal(meta.gameID.length, 32);
  const chat = JSON.parse(new TextDecoder().decode(secs.find((s) => s.id === SECTION.CHAT)!.payload));
  assert.equal(chat.length, 2);
  assert.equal(chat[0]![3], "gl hf");
});

function gunzip(buf: Uint8Array): Uint8Array {
  return gunzipSync(buf);
}
