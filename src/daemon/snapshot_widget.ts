/**
 * Lua widget injected into the game data by the resim daemon. Hooks engine
 * callins and prints `ZKR <json>` lines on stdout; the daemon captures those
 * into the POS/EVNT/PROJ/LINK/UDEF/WDEF sections (spec §§A-C, §L, probe rate
 * 0.2 s).
 */
export const SNAPSHOT_WIDGET_NAME = "zkreplay_snapshot.lua";

export const SNAPSHOT_WIDGET_LUA = String.raw`
local probeEvery = 6 -- frames between probes (6 @ 30 fps = 0.2 s)
local knownUnitDefs = {}
local knownWeaponDefs = {}

local function emit(json)
  Spring.Echo("ZKR " .. json)
end

local function num(v)
  v = tonumber(v)
  if v == nil then return "null" end
  return string.format("%.3f", v)
end

local function frac(v)
  v = tonumber(v)
  if v == nil or v < 0 then return "null" end
  return string.format("%d", math.floor(math.max(0, math.min(1, v)) * 255 + 0.5))
end

local function maybeUdef(defID)
  if defID == nil or knownUnitDefs[defID] then return end
  knownUnitDefs[defID] = true
  local d = UnitDefs[defID]
  if d == nil then return end
  emit('{"t":"udef","d":' .. defID .. ',"n":"' .. d.name .. '","m":' .. num(d.metalCost) ..
    ',"hp":' .. num(d.health) .. '}')
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
  local mw, mh = Spring.GetMapSize()
  emit('{"t":"meta","w":' .. num(mw) .. ',"h":' .. num(mh) .. '}')
end

function widget:UnitCreated(unitID, unitDefID, unitTeam, builderID)
  maybeUdef(unitDefID)
  local name = ""
  if unitDefID ~= nil and UnitDefs[unitDefID] ~= nil then name = UnitDefs[unitDefID].name or "" end
  local builderDef = -1
  if builderID ~= nil and builderID > 0 then
    builderDef = Spring.GetUnitDefID(builderID) or -1
    maybeUdef(builderDef)
  end
  emit('{"t":"spawn","f":' .. Spring.GetGameFrame() .. ',"u":' .. unitID ..
    ',"d":' .. (unitDefID or -1) .. ',"n":"' .. name .. '","tm":' .. (unitTeam or -1) ..
    ',"b":' .. (builderID or -1) .. ',"bd":' .. builderDef .. '}')
end

function widget:UnitDestroyed(unitID, unitDefID, unitTeam, attackerID, attackerDefID, attackerTeam, weaponDefID)
  if attackerDefID ~= nil and attackerDefID >= 0 then maybeWdef(attackerDefID) end
  emit('{"t":"death","f":' .. Spring.GetGameFrame() .. ',"u":' .. unitID ..
    ',"k":' .. (attackerID or -1) .. ',"kt":' .. (attackerTeam or -1) ..
    ',"w":' .. (weaponDefID or attackerDefID or -1) .. '}')
end

function widget:GameFrame(frame)
  if frame % probeEvery ~= 0 then return end
  local units = Spring.GetAllUnits()
  local rows = {}
  for i = 1, #units do
    local uid = units[i]
    local x, y, z = Spring.GetUnitPosition(uid)
    local hp, maxHp = Spring.GetUnitHealth(uid)
    local build = select(5, Spring.GetUnitHealth(uid))
    rows[#rows + 1] = "[" .. uid .. "," .. num(x) .. "," .. num(z) ..
      "," .. frac(maxHp and maxHp > 0 and hp / maxHp or nil) ..
      "," .. frac(build and 1 or nil) .. "]"
  end
  if #rows > 0 then
    emit('{"t":"pos","f":' .. frame .. ',"p":[' .. table.concat(rows, ",") .. ']}')
  end
  local projs = Spring.GetProjectileList()
  for i = 1, #projs do
    local pid = projs[i]
    local wdefID = Spring.GetProjectileDefID(pid)
    if wdefID ~= nil and wdefID >= 0 then
      maybeWdef(wdefID)
      local x, y, z = Spring.GetProjectilePosition(pid)
      local team = Spring.GetProjectileTeamID(pid)
      emit('{"t":"proj","f":' .. frame .. ',"u":' .. pid ..
        ',"d":' .. wdefID .. ',"tm":' .. (team or -1) ..
        ',"x":' .. num(x) .. ',"y":' .. num(y) .. ',"z":' .. num(z) .. '}')
    end
  end
end

function widget:GameOver(winningAllyTeams)
  local w = {}
  for i = 1, #(winningAllyTeams or {}) do w[i] = tostring(winningAllyTeams[i]) end
  emit('{"t":"gameover","f":' .. Spring.GetGameFrame() .. ',"winners":[' .. table.concat(w, ",") .. ']}')
end
`;
