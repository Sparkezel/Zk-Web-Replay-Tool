/**
 * Lua widget injected into the game data by the resim daemon. Hooks engine
 * callins and prints `ZKR <json>` lines on stdout; the daemon captures those
 * into the POS/EVNT/PROJ/LINK/UDEF/WDEF sections (spec §§A-C, §L, probe rate
 * 0.2 s).
 */
export const SNAPSHOT_WIDGET_NAME = "zkreplay_snapshot.lua";

export interface WidgetInjectionOptions {
  /** wanted sim-speed factor; each engine /speedup steps 0.1 below 2x, 0.2 below 5x, 0.5 beyond */
  speedFactor?: number;
}

/** count of `/speedup` sends a widget needs on GameStart to reach the factor */
export function speedUpPressesFor(targetFactor: number): number {
  let presses = 0;
  let speed = 1.0;
  while (speed < targetFactor - 1e-6 && presses < 1000) {
    speed += speed < 2 ? 0.1 : speed < 5 ? 0.2 : 0.5;
    presses++;
  }
  return presses;
}

export const SNAPSHOT_WIDGET_LUA = String.raw`
function widget:GetInfo()
  return {
    name    = "ZKR Snapshot",
    desc    = "Captures POS/EVNT/PROJ/LINK data and prints ZKR lines for the resim daemon",
    author  = "zk-web-replay-tool",
    date    = "2026-07-04",
    license = "GPL-2.0-or-later",
    layer   = 0,
    enabled = true,
  }
end

local probeEvery = 6 -- frames between probes (6 @ 30 fps = 0.2 s)
local knownUnitDefs = {}
local knownWeaponDefs = {}

-- wanted sim-speed factor for fast-forward (templated by the daemon); the
-- engine clamps to GameSetup maxSpeed, /speedup steps 0.1 below 2x, 0.2 below
-- 5x, 0.5 below 10x, 1.0 beyond
local targetSpeed = tonumber("__ZKR_SPEED_FACTOR__") or 1

-- engine bookkeeping units (ZK terraform helper "terraunit") are invisible
-- blobs created by terraform gadgets; tracking their hp/position is noise, so
-- they never get spawn/death events or probe rows
local excludedDefIDs = {}
local excludedUnitIDs = {}

local function emit(json)
  Spring.Echo("ZKR " .. json)
end

-- integer elmo (2-3 bytes shorter per coord than %.3f; the packer quantizes
-- to u16 anyway) - "null" when the engine returned nothing
local function ipos(v)
  if v == nil then return "null" end
  return string.format("%d", math.floor(v))
end

local function num(v)
  v = tonumber(v)
  if v == nil then return "null" end
  return string.format("%.3f", v)
end

-- raw 0..1 fraction ("null" when unknown); the daemon scales to 0..255 at pack time
local function frac(v)
  v = tonumber(v)
  if v == nil or v < 0 then return "null" end
  return string.format("%.3f", math.max(0, math.min(1, v)))
end

local function maybeUdef(defID)
  if defID == nil or knownUnitDefs[defID] then return end
  knownUnitDefs[defID] = true
  local d = UnitDefs[defID]
  if d == nil then return end
  -- area cloaker detection (Iris, Onion, ...): the cloak field radius comes
  -- either from a Cloaker-type weapon's range (engine-side cloaking) or from
  -- the unitdef custom params (gadget-implemented area cloak, e.g. ZK's
  -- Cloaker Shield); whichever carries a number wins
  local cloakRadius = nil
  local weapons = d.weapons or {}
  for i = 1, #weapons do
    local wd = WeaponDefs[weapons[i] ~= nil and (weapons[i].weaponDef or weapons[i][1]) or nil]
    if wd ~= nil and wd.range ~= nil and wd.range > 0 then
      local wtype = string.lower(wd.type or "")
      if wtype:find("cloak", 1, true) then
        cloakRadius = wd.range
        break
      end
    end
  end
  if cloakRadius == nil then
    -- ZK's area-cloak gadget carries the field radius as a dedicated param
    -- (real def: area_cloak_radius = 350 alongside area_cloak_recloak_rate
    -- = 800 etc - matching any "*cloak*" key is ambiguous, so match the
    -- radius key exactly first, then *_cloak_radius suffixed keys)
    local cp = d.customParams or d.customparams or {}
    local radius = tonumber(cp["area_cloak_radius"]) or tonumber(cp.area_cloak_radius)
    if radius == nil then
      for k, v in pairs(cp) do
        if type(v) == "string" and string.sub(string.lower(k), -13) == "_cloak_radius" then
          local n = tonumber(v)
          if n ~= nil and n >= 50 then radius = n break end
        end
      end
    end
    if radius ~= nil then cloakRadius = radius end
  end
  local cr = ""
  if cloakRadius ~= nil then cr = ',"cr":' .. cloakRadius end
  emit('{"t":"udef","d":' .. defID .. ',"n":"' .. d.name .. '","m":' .. num(d.metalCost) ..
    ',"hp":' .. num(d.health) .. ',"mv":' .. (d.canMove and 1 or 0) ..
    ',"ic":"' .. (d.iconType or "") .. '","hn":"' .. (d.humanName or "") .. '"' .. cr .. '}')
end

local function maybeWdef(defID)
  if defID == nil or defID < 0 or knownWeaponDefs[defID] then return end
  knownWeaponDefs[defID] = true
  local d = WeaponDefs[defID]
  if d == nil then return end
  local cp = d.customParams or {}
  emit('{"t":"wdef","d":' .. defID .. ',"n":"' .. (d.name or "") .. '","w":"' .. (d.type or "") ..
    '","r":' .. num(d.range) .. ',"th":' .. num(d.trajectoryHeight) ..
    ',"cp":{"isnuke":"' .. tostring(cp.isnuke or "") ..
    '","interceptor":"' .. tostring(cp.interceptor or "") .. '"}}')
end

function widget:Initialize()
  for defID = 1, #UnitDefs do
    if UnitDefs[defID] ~= nil and UnitDefs[defID].name == "terraunit" then
      excludedDefIDs[defID] = true
    end
  end
  emit('{"t":"meta","w":' .. num(Game.mapSizeX) .. ',"h":' .. num(Game.mapSizeZ) .. '}')
end

function widget:UnitCreated(unitID, unitDefID, unitTeam, builderID)
  if excludedDefIDs[unitDefID] then excludedUnitIDs[unitID] = true return end
  maybeUdef(unitDefID)
  local name = ""
  if unitDefID ~= nil and UnitDefs[unitDefID] ~= nil then name = UnitDefs[unitDefID].name or "" end
  local builderDef = -1
  if builderID ~= nil and builderID > 0 then
    builderDef = Spring.GetUnitDefID(builderID) or -1
    maybeUdef(builderDef)
  end
  local x, _, z = Spring.GetUnitPosition(unitID)
  emit('{"t":"spawn","f":' .. Spring.GetGameFrame() .. ',"u":' .. unitID ..
    ',"d":' .. (unitDefID or -1) .. ',"n":"' .. name .. '","tm":' .. (unitTeam or -1) ..
    ',"b":' .. (builderID or -1) .. ',"bd":' .. builderDef ..
    ',"x":' .. num(x) .. ',"z":' .. num(z) .. '}')
end

function widget:UnitDestroyed(unitID, unitDefID, unitTeam, attackerID, attackerDefID, attackerTeam, weaponDefID)
  if excludedDefIDs[unitDefID] then excludedUnitIDs[unitID] = nil return end
  if attackerDefID ~= nil and attackerDefID >= 0 then maybeWdef(attackerDefID) end
  emit('{"t":"death","f":' .. Spring.GetGameFrame() .. ',"u":' .. unitID ..
    ',"k":' .. (attackerID or -1) .. ',"kt":' .. (attackerTeam or -1) ..
    ',"w":' .. (weaponDefID or attackerDefID or -1) .. '}')
end

-- port of the daemon-side spec §C classifier (src/daemon/classify.ts): only
-- projectiles whose class survives the preset are echo'd. Spring.Echo lines
-- hit stdout AND infolog.txt, so every dropped projectile skipped here is
-- volume saved in both sinks.
local DROPPED_TYPES = { AircraftBomb = true, Melee = true, Shield = true,
  LightningCannon = true, TorpedoLauncher = true }
local projClassByID = {}
local function classifyWeapon(d, cp)
  local name = string.lower(d.name or "")
  if name:find("fake", 1, true) or name:find("bogus", 1, true) or
     name:find("party", 1, true) or name:find("tele_beacon_target", 1, true) then return 0 end
  local wtype = d.type or ""
  if DROPPED_TYPES[wtype] then return 0 end
  local isnuke = (cp ~= nil and cp.isnuke == "1") or name:find("nuke", 1, true) ~= nil
  if wtype == "StarburstLauncher" then return isnuke and 3 or 4 end
  local range = d.range or 0
  if wtype == "MissileLauncher" then
    if isnuke then return 3 end
    if range >= 900 then return 4 end
    return 0
  end
  if cp ~= nil and cp.interceptor == "1" then return 5 end
  if (wtype == "BeamLaser" or wtype == "LaserCannon") and range >= 900 then return 1 end
  if wtype == "Cannon" and (range >= 1000 or ((d.trajectoryHeight or 0) > 0 and range >= 800)) then return 2 end
  return 0
end

local projMode = "__ZKR_PROJ_MODE__"
local keepProjClass = { [1] = true, [2] = true, [3] = true, [4] = true, [5] = true } -- heavy
if projMode == "none" then keepProjClass = {}
elseif projMode == "beams" then keepProjClass = { [1] = true }
elseif projMode == "all" then keepProjClass = { [0] = true, [1] = true, [2] = true, [3] = true, [4] = true, [5] = true } end

function widget:GameFrame(frame)
  maybeSendStartboxes()
  -- press /speedup every probe frame while the engine's wanted factor is below
  -- target; supplements the GameStart burst in case those presses raced server
  -- boot or got dropped. Stops pressing once wanted >= target (idempotent).
  if targetSpeed > 1 and frame % probeEvery == 0 then
    local wanted = select(1, Spring.GetGameSpeed())
    if wanted ~= nil and wanted < targetSpeed - 0.001 then
      Spring.SendCommands("speedup")
    end
  end
  if frame % probeEvery ~= 0 then return end
  local units = Spring.GetAllUnits()
  local rows = {}
  for i = 1, #units do
    local uid = units[i]
    if excludedUnitIDs[uid] ~= true then
      local x, y, z = Spring.GetUnitPosition(uid)
      local hp, maxHp = Spring.GetUnitHealth(uid)
      local build = select(5, Spring.GetUnitHealth(uid))
      -- cloak state: 1 when the unit is cloaked right now (own cloak or inside
      -- an Iris/Onion area field) — the viewer draws a cyan dot under it
      local ck = false
      if Spring.GetUnitIsCloaked ~= nil then ck = Spring.GetUnitIsCloaked(uid) or false end
      rows[#rows + 1] = "[" .. uid .. "," .. ipos(x) .. "," .. ipos(z) ..
        "," .. frac(maxHp and maxHp > 0 and hp / maxHp or nil) ..
        "," .. frac(build and 1 or nil) .. "," .. (ck and 1 or 0) .. "]"
    end
  end
  if #rows > 0 then
    emit('{"t":"pos","f":' .. frame .. ',"p":[' .. table.concat(rows, ",") .. ']}')
  end
  local projs = Spring.GetAllProjectiles()
  for i = 1, #projs do
    local pid = projs[i]
    local wdefID = Spring.GetProjectileDefID(pid)
    if wdefID ~= nil and wdefID >= 0 then
      local cls = projClassByID[wdefID]
      if cls == nil then
        local d = WeaponDefs[wdefID]
        cls = d ~= nil and classifyWeapon(d, d.customParams or {}) or 0
        projClassByID[wdefID] = cls
        if d ~= nil then maybeWdef(wdefID) end
      end
      if keepProjClass[cls] then
        local x, y, z = Spring.GetProjectilePosition(pid)
        local team = Spring.GetProjectileTeamID(pid)
        emit('{"t":"proj","f":' .. frame .. ',"u":' .. pid ..
          ',"d":' .. wdefID .. ',"tm":' .. (team or -1) ..
          ',"x":' .. ipos(x) .. ',"y":' .. ipos(y) .. ',"z":' .. ipos(z) .. '}')
      end
    end
  end
end

function widget:GameStart()
  local presses = __ZKR_SPEEDUP_PRESSES__
  for i = 1, presses do
    Spring.SendCommands("speedup")
  end
  maybeSendStartboxes()
end

-- startboxes: the ZK start_boxes gadget loads them from the map/game config
-- (mapconfig/map_startboxes.lua or LuaRules/Configs/StartBoxes/<map>.lua) and
-- exposes them as game-rules params; vertices are always elmos. Per-allyteam
-- assignment (start_box_id team param) is set in that gadget's Initialize,
-- so it is already final by GameStart.
local sbxSent = false
local function numOr0(v) local n = tonumber(v) if n == nil then return 0 end return n end

function maybeSendStartboxes()
  if sbxSent then return end
  local boxCount = numOr0(Spring.GetGameRulesParam("startbox_max_n"))
  if boxCount <= 0 then
    if Spring.GetGameFrame() > 300 then sbxSent = true end
    return
  end
  local mapX = numOr0(Game.mapSizeX)
  local mapZ = numOr0(Game.mapSizeZ)
  if mapX <= 0 or mapZ <= 0 then return end
  local boxes = {}
  for id = 0, boxCount do
    local polyCount = numOr0(Spring.GetGameRulesParam("startbox_n_" .. id))
    if polyCount > 0 then
      local polys = {}
      for i = 1, polyCount do
        local verts = {}
        local vcount = numOr0(Spring.GetGameRulesParam("startbox_polygon_" .. id .. "_" .. i))
        for j = 1, vcount do
          local vx = numOr0(Spring.GetGameRulesParam("startbox_polygon_x_" .. id .. "_" .. i .. "_" .. j)) / mapX
          local vz = numOr0(Spring.GetGameRulesParam("startbox_polygon_z_" .. id .. "_" .. i .. "_" .. j)) / mapZ
          verts[#verts + 1] = '[' .. string.format("%.4f,%.4f", vx, vz) .. ']'
        end
        polys[#polys + 1] = '[' .. table.concat(verts, ',') .. ']'
      end
      boxes[#boxes + 1] = '"' .. id .. '":[' .. table.concat(polys, ',') .. ']'
    end
  end
  local mapping = {}
  local atList = Spring.GetAllyTeamList() or {}
  for k = 1, #atList do
    local teams = Spring.GetTeamList(atList[k]) or {}
    if #teams > 0 then
      local boxID = Spring.GetTeamRulesParam(teams[1], "start_box_id")
      if boxID ~= nil then mapping[#mapping + 1] = '"' .. atList[k] .. '":' .. boxID end
    end
  end
  emit('{"t":"sbx","b":{' .. table.concat(boxes, ',') .. '},"m":{' .. table.concat(mapping, ',') .. '}}')
  sbxSent = true
end

function widget:GameOver(winningAllyTeams)
  local w = {}
  for i = 1, #(winningAllyTeams or {}) do w[i] = tostring(winningAllyTeams[i]) end
  emit('{"t":"gameover","f":' .. Spring.GetGameFrame() .. ',"winners":[' .. table.concat(w, ",") .. ']}')
end
`;
