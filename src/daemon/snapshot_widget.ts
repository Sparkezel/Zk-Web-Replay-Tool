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

-- shield info per unitdef (computed at udef discovery): the Shield weapon's
-- shieldPower gives the max charge for runtime fraction reads; the radius
-- (>= 200 elmos = area shield in ZK's own classification) travels in the
-- UDEF section and decides circle vs fallback bar in the viewer
local shieldPowerByDef = {}

-- live per-unit states (slow/EMP/disarm/fire): last-emitted snapshot per
-- unit for sparsity, plus the overflow rows for the current probe (the
-- flush emits them chunked under the engine's console-line cap, exactly
-- like pos rows; each row carries its own frame)
-- forward declaration: flushStatRows (below) emits through the same
-- line-emitter as every other widget row — the local must exist before
-- any function that references it is COMPILED, or the reference compiles
-- as a nil global and blows up at the first stat flush
local emit

local lastStates = {}
local statRows = {}
local function flushStatRows()
  if #statRows == 0 then return end
  local STAT_LINE_BUDGET = 2048
  local out, len = {}, 0
  for i = 1, #statRows do
    if len + #statRows[i] + 1 > STAT_LINE_BUDGET then
      emit('{"t":"stat","p":[' .. table.concat(out, ",") .. ']}')
      out, len = {}, 0
    end
    out[#out + 1] = statRows[i]
    len = len + #statRows[i] + 1
  end
  if #out > 0 then emit('{"t":"stat","p":[' .. table.concat(out, ",") .. ']}') end
  statRows = {}
end

function emit(json)
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
  -- shield discovery: the first Shield-type weapon carries radius/max
  -- charge (shieldPower). Radius >= 200 = area shield (aspis, aegis,
  -- funnelweb, comm areashield module); smaller personal shields (thug,
  -- felon, comm personal module) get the fallback bar only
  local shieldRadius, shieldPower
  for i = 1, #weapons do
    local wd = WeaponDefs[weapons[i] ~= nil and (weapons[i].weaponDef or weapons[i][1]) or nil]
    if wd ~= nil and wd.type == "Shield" then
      shieldRadius = wd.shieldRadius or 0
      shieldPower = wd.shieldPower or 0
      break
    end
  end
  if shieldRadius ~= nil then
    shieldPowerByDef[defID] = shieldPower
  end
  local cr = ""
  if cloakRadius ~= nil then cr = ',"cr":' .. cloakRadius end
  local sr = ""
  if shieldRadius ~= nil then
    sr = ',"sr":' .. shieldRadius .. ',"sp":' .. shieldPower
  end
  -- anti-nuke coverage: ZK's own coverage widget reads the same param
  -- (staticantinuke: nuke_coverage = 2500 elmos); units without it (the
  -- missiles themselves, fake launchers) simply omit the field
  local cpU = d.customParams or d.customparams or {}
  local anc = tonumber(cpU.nuke_coverage)
  local an = ""
  if anc ~= nil then an = ',"anc":' .. anc end
  emit('{"t":"udef","d":' .. defID .. ',"n":"' .. d.name .. '","m":' .. num(d.metalCost) ..
    ',"hp":' .. num(d.health) .. ',"mv":' .. (d.canMove and 1 or 0) ..
    ',"ic":"' .. (d.iconType or "") .. '","hn":"' .. (d.humanName or "") .. '"' .. cr .. sr .. an .. '}')
end

local function maybeWdef(defID)
  if defID == nil or defID < 0 or knownWeaponDefs[defID] then return end
  knownWeaponDefs[defID] = true
  local d = WeaponDefs[defID]
  if d == nil then return end
  local cp = d.customParams or {}
  -- explosion AOE: ZK's attack-AoE widget's precedence (gui_aoe override,
  -- then the engine's damageAreaOfEffect); napalm ground patches carry
  -- their own radius/duration separately (area_damage = 1)
  local aoe = tonumber(cp.gui_aoe) or tonumber(d.damageAreaOfEffect) or 0
  local adr, adu = 0, 0
  -- napalm flag: ZK's own lups_napalm gadget classes a weapon as napalm by
  -- its description (e.g. "Napalm Mortar") or lups_napalm_fx/lups_heat_fx;
  -- area_damage ALONE also covers slow fields (missileslow) and the Dante's
  -- black hole, which must NOT paint fire patches in the viewer
  local nd = 0
  if tostring(d.description or ""):lower():find("napalm", 1, true)
     or cp.lups_napalm_fx ~= nil or cp.lups_heat_fx ~= nil then nd = 1 end
  -- area-damage radius/duration record for EVERY area_damage weapon, not
  -- just napalm: Zeno's slow field and the Dante's black hole carry the
  -- same customParams, and the VIEWER decides by nd (fire) or by weapon
  -- name (slow field) what paints; napalm without explicit params keeps
  -- the old aoe/15s fallback
  if nd == 1 or cp.area_damage ~= nil or cp.area_damage_radius ~= nil then
    adr = tonumber(cp.area_damage_radius) or 0
    adu = tonumber(cp.area_damage_duration) or 0
    if cp.area_damage == nil then adr, adu = aoe, 15 end
  end
  emit('{"t":"wdef","d":' .. defID .. ',"n":"' .. (d.name or "") .. '","w":"' .. (d.type or "") ..
    '","r":' .. num(d.range) .. ',"th":' .. num(d.trajectoryHeight) ..
    ',"aoe":' .. num(aoe) .. ',"adr":' .. num(adr) .. ',"adu":' .. num(adu) ..
    ',"nd":' .. nd ..
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
  lastStates[unitID] = nil
  if excludedDefIDs[unitDefID] then excludedUnitIDs[unitID] = nil return end
  if attackerDefID ~= nil and attackerDefID >= 0 then maybeWdef(attackerDefID) end
  emit('{"t":"death","f":' .. Spring.GetGameFrame() .. ',"u":' .. unitID ..
    ',"k":' .. (attackerID or -1) .. ',"kt":' .. (attackerTeam or -1) ..
    ',"w":' .. (weaponDefID or attackerDefID or -1) .. '}')
end

-- wreck features: Spring spawns a *_dead / *_heap feature when a unit dies;
-- reclaiming (or collapsing) destroys it, so the viewer can paint wreck
-- dots with the engine-authoritative metal and remove them on reclaim.
-- The headless resim engine (spring-headless.exe) does NOT deliver the
-- unsynced FeatureCreated/FeatureDestroyed callins (proven on the Otago
-- resim: 1015 corpses, zero wrk lines despite on-map reclamation), so the
-- lifecycle is POLLED once per second over Spring.GetAllFeatures() - new
-- wreck-named features are announced, disappeared ones uwrk'd. Where the
-- callins do fire they share the same registry and nothing double-emits.
local wreckFeatures = {}
local wreckDefCache = {}

function isWreckFeatureName(name)
  if name == nil then return false end
  return string.find(name, "_dead", -5, true) ~= nil
    or string.find(name, "_heap", -5, true) ~= nil
    or string.find(name, "_wreck", -6, true) ~= nil
end

local function isWreckDefID(fdid)
  if fdid == nil then return false end
  local cached = wreckDefCache[fdid]
  if cached == nil then
    local fd = FeatureDefs[fdid]
    cached = (fd ~= nil and isWreckFeatureName(fd.name)) or false
    wreckDefCache[fdid] = cached
  end
  return cached
end

local function emitWreck(featureID, fdid)
  local fd = FeatureDefs[fdid]
  local x, _, z = Spring.GetFeaturePosition(featureID)
  emit('{"t":"wrk","f":' .. Spring.GetGameFrame() .. ',"u":' .. featureID ..
    ',"m":' .. num(fd and fd.metal) ..
    ',"x":' .. num(x) .. ',"z":' .. num(z) .. '}')
end

function widget:FeatureCreated(featureID)
  local fdid = Spring.GetFeatureDefID(featureID)
  if not isWreckDefID(fdid) or wreckFeatures[featureID] then return end
  wreckFeatures[featureID] = true
  emitWreck(featureID, fdid)
end

function widget:FeatureDestroyed(featureID)
  if not wreckFeatures[featureID] then return end
  wreckFeatures[featureID] = nil
  emit('{"t":"uwrk","f":' .. Spring.GetGameFrame() .. ',"u":' .. featureID .. '}')
end

-- 1-second lifecycle poll (the headless engine skips the callins above)
local function pollWreckFeatures()
  local alive = {}
  local feats = (Spring.GetAllFeatures ~= nil and Spring.GetAllFeatures()) or {}
  for i = 1, #feats do
    local fid = feats[i]
    alive[fid] = true
    if not wreckFeatures[fid] then
      local fdid = Spring.GetFeatureDefID(fid)
      if isWreckDefID(fdid) then
        wreckFeatures[fid] = true
        emitWreck(fid, fdid)
      end
    end
  end
  for fid in pairs(wreckFeatures) do
    if not alive[fid] then
      wreckFeatures[fid] = nil
      emit('{"t":"uwrk","f":' .. Spring.GetGameFrame() .. ',"u":' .. fid .. '}')
    end
  end
end

-- port of the daemon-side spec §C classifier (src/daemon/classify.ts): only
-- projectiles whose class survives the preset are echo'd. Spring.Echo lines
-- hit stdout AND infolog.txt, so every dropped projectile skipped here is
-- volume saved in both sinks.
local DROPPED_TYPES = { AircraftBomb = true, Melee = true, Shield = true,
  LightningCannon = true, TorpedoLauncher = true }
local projClassByID = {}
-- sent strategic missiles, by ZK's weapon-name unit key (the viewer matches
-- the same keys): these get their COMMANDED target polled once per flight,
-- so an antinuke-intercepted warhead still tells the replay where the
-- strike would have landed
local STRAT_MISSILE_KEYS = { tacnuke = true, empmissile = true, missileslow = true,
  seismic = true, napalmmissile = true, staticnuke = true }
local lastPtgt = {}
-- ZK's own napalm classification (LuaRules/gadgets/lups_napalm.lua): weapon
-- description contains "Napalm" or the lups heat/napalm fx is set. Area
-- damage ALONE is not fire - the slow missile's slow field and the Dante's
-- black hole are area damage too but must not record as napalm
local function isNapalmWeapon(d, cp)
  if tostring(d.description or ""):lower():find("napalm", 1, true) then return true end
  return cp ~= nil and (cp.lups_napalm_fx ~= nil or cp.lups_heat_fx ~= nil)
end
local function classifyWeapon(d, cp)
  -- NAPALM FIRST, before the name-drop patterns: ZK prefixes weapon names
  -- with the unit key, so the Firewalker's mortar is jumparty_napalm_sprayer
  -- and the "party" filter below would silently drop it (and the DRP's own
  -- burn weapons). Class 2 (artillery) fits the shell arc
  if cp ~= nil and cp.area_damage == "1" and isNapalmWeapon(d, cp) then return 2 end
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

-- shield charge fraction (0..1) for a unit right now; nil when it has no
-- shield. Dyncomms publish their runtime shield module via comm_shield_*
-- rules params (weapon number + max charge) because the module is not part
-- of the base unitdef; regular units use the unitdef's Shield weapon
local function shieldFrac(uid, defID)
  local max = shieldPowerByDef[defID] or 0
  local charge
  local commMax = Spring.GetUnitRulesParam(uid, "comm_shield_max")
  if commMax ~= nil and commMax > 0 then
    max = commMax
    local commNum = Spring.GetUnitRulesParam(uid, "comm_shield_num")
    charge = select(2, Spring.GetUnitShieldState(uid, commNum))
  elseif max > 0 then
    charge = select(2, Spring.GetUnitShieldState(uid))
  end
  if charge == nil or max <= 0 then return nil end
  return math.max(0, math.min(1, charge / max))
end

function widget:GameFrame(frame)
  maybeSendStartboxes()
  maybeSendMetalSpots()
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
  -- wreck lifecycle poll: every 30 frames (1 s) - the headless engine
  -- never delivers the FeatureCreated/FeatureDestroyed callins
  if frame % 30 == 0 then pollWreckFeatures() end
  local units = Spring.GetAllUnits()
  -- pos rows are CHUNKED into several short lines per probe: the engine
  -- hard-caps a single console line near 32 KB, and a large battle with
  -- hundreds of live units blows that cap - the JSON tail gets chopped
  -- (measured: 32798-char truncated pos lines came out as malformed on the
  -- Comet Catcher stress replay). ~2 KB per line stays far under it; the
  -- daemon ingest appends per line, so several pos lines per frame merge
  -- into the same probe seamlessly.
  local POS_LINE_BUDGET = 2048
  local rows, rowsLen = {}, 0
  local function flushRows()
    if #rows == 0 then return end
    emit('{"t":"pos","f":' .. frame .. ',"p":[' .. table.concat(rows, ",") .. ']}')
    rows, rowsLen = {}, 0
  end
  for i = 1, #units do
    local uid = units[i]
    if excludedUnitIDs[uid] ~= true then
      local x, y, z = Spring.GetUnitPosition(uid)
      local hp, maxHp = Spring.GetUnitHealth(uid)
      local build = select(5, Spring.GetUnitHealth(uid))
      -- cloak bits: 1 = unit cloaked right now (own/personal/ally-field), the
      -- viewer draws a cyan dot under it; 2 = THIS unit's area-cloak field is
      -- active (ZK's cloak_shield gadget rules param: 2 = grown and running,
      -- 1 = stalled/unpowered -> bit 4, 0 = toggled off)
      local ck = false
      if Spring.GetUnitIsCloaked ~= nil then ck = Spring.GetUnitIsCloaked(uid) or false end
      local cs = Spring.GetUnitRulesParam(uid, "cloak_shield")
      local cf = cs == 2
      local csBit = cs == 1
      local sh = shieldFrac(uid, Spring.GetUnitDefID(uid))
      local row = "[" .. uid .. "," .. ipos(x) .. "," .. ipos(z) ..
        "," .. frac(maxHp and maxHp > 0 and hp / maxHp or nil) ..
        "," .. frac(build) .. "," ..
        ((ck and 1 or 0) + (cf and 2 or 0) + (csBit and 4 or 0)) ..
        "," .. frac(sh) .. "]"
      if rowsLen + #row + 1 > POS_LINE_BUDGET then flushRows() end
      rows[#rows + 1] = row
      rowsLen = rowsLen + #row + 1
      -- LIVE STATES (slow / EMP shock / disarm / on fire) are sparse events,
      -- not per-sample columns: emitted only when the bit set changes or the
      -- slow level crosses a 1/16 step (the purple dot fades in as slow
      -- damage stacks; EMP and disarm only matter at 100% effect)
      local meta = lastStates[uid]
      local slq = math.floor((tonumber(Spring.GetUnitRulesParam(uid, "slowState") or "0") + 0.03125) * 16)
      if slq < 0 then slq = 0 end
      if slq > 16 then slq = 16 end
      local bits = 0
      -- rules params come back as NUMBERS from the engine (ZK's own
      -- unit_healthbars.lua compares == 1) — a == "1" string compare never
      -- fires and both states silently never record
      if tonumber(Spring.GetUnitRulesParam(uid, "on_fire") or 0) == 1 then bits = bits + 1 end
      if tonumber(Spring.GetUnitRulesParam(uid, "disarmed") or 0) == 1 then bits = bits + 2 end
      -- Spring's own EMP: stunned means the FULL paralysis (partial EMP
      -- build-up is ignored by design - the effect only reads at 100%)
      local stunned = select(1, Spring.GetUnitIsStunned(uid))
      if stunned == true then bits = bits + 4 end
      if meta == nil or meta.bits ~= bits or meta.slq ~= slq then
        -- state semantics need no "all zero" baseline row: the decode treats
        -- everything before the first event as healthy; but a transition BACK
        -- to zero must be recorded, so the nz flag tracks whether the unit has
        -- ever appeared affected
        local wasNz = meta ~= nil and (meta.bits ~= 0 or meta.slq ~= 0)
        if (bits ~= 0 or slq ~= 0 or wasNz) then
          statRows[#statRows + 1] = "[" .. uid .. "," .. frame .. "," .. bits .. "," .. slq .. "]"
        end
        lastStates[uid] = { bits = bits, slq = slq }
      end
    end
  end
  flushRows()
  flushStatRows(frame)
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
        -- strategic missiles (Eos/Shockley/Zeno/Quake/Inferno/Trinity): the
        -- COMMANDED target of the flight. The path alone cannot tell where
        -- an antinuke-intercepted warhead was headed (kills at ignition
        -- leave zero movement), and the strike circle must mark the real
        -- destination, never the intercept point.
        -- Spring.GetProjectileTarget returns (targetType, targetData):
        --   103 = ground   -> targetData = {[1]=x, [2]=y, [3]=z} (array
        --                      form, NO .x/.z named keys - ZK's own
        --                      unit_antinuke_handler.lua reads [1]/[3])
        --   117 = unit    -> targetData = unitID
        --   102 = feature -> targetData = featureID (separate id space!)
        -- Emitted once per (pid, quantized target); probed every frame
        -- while a strategic projectile exists, re-emitted only when the
        -- engine hands a different target (retargeting; recycled pids with
        -- a different target). pcall degrades safely on engines without
        -- the API (ok = false -> no line).
        local wd = WeaponDefs[wdefID]
        local wkey = wd ~= nil and wd.name ~= nil and string.match(wd.name, "^([^_]+)") or nil
        if wkey ~= nil and STRAT_MISSILE_KEYS[wkey] then
          local ok, ttype, tdata = pcall(Spring.GetProjectileTarget, pid)
          local tx, tz
          if ok and ttype ~= nil then
            if ttype == 103 and type(tdata) == "table" then
              tx, tz = tdata[1], tdata[3]
            elseif ttype == 117 and type(tdata) == "number" then
              local ux, uy, uz = Spring.GetUnitPosition(tdata)
              if ux ~= nil then tx, tz = ux, uz end
            elseif ttype == 102 and type(tdata) == "number" then
              local fx, fy, fz = Spring.GetFeaturePosition(tdata)
              if fx ~= nil then tx, tz = fx, fz end
            elseif type(tdata) == "table" then
              -- unknown (type, table) combo on some other engine build:
              -- best effort, array form first, named form second
              tx, tz = tdata[1], tdata[3]
              if tx == nil or tz == nil then tx, tz = tdata.x, tdata.z end
            end
          end
          if tx ~= nil and tz ~= nil then
            local key = ipos(tx) .. ":" .. ipos(tz)
            if lastPtgt[pid] ~= key then
              lastPtgt[pid] = key
              emit('{"t":"ptgt","f":' .. frame .. ',"u":' .. pid ..
                ',"x":' .. ipos(tx) .. ',"z":' .. ipos(tz) .. '}')
            end
          end
        end
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
  maybeSendMetalSpots()
end

-- map metal spots: ZK's mex placement gadget publishes them as game-rules
-- params (the same source api_mexspot_fetcher.lua builds WG.metalSpots from)
-- — exact positions in elmos plus per-spot metal income. Emitted once per
-- line at start (a per-spot line stays far under the engine's console cap
-- on spot-dense maps); maps without metal carry no mex_count param and give
-- up after the probe window, mirroring the startbox retry.
local mespSent = false
function maybeSendMetalSpots()
  if mespSent then return end
  local count = tonumber(Spring.GetGameRulesParam("mex_count"))
  if count == nil then
    if Spring.GetGameFrame() > 300 then mespSent = true end
    return
  end
  if count == -1 then
    mespSent = true -- game says "no metal map" explicitly
    return
  end
  if count <= 0 then return end
  for i = 1, count do
    local x = Spring.GetGameRulesParam("mex_x" .. i)
    local z = Spring.GetGameRulesParam("mex_z" .. i)
    if x ~= nil and z ~= nil then
      local m = Spring.GetGameRulesParam("mex_metal" .. i)
      emit('{"t":"mesp","x":' .. num(x) .. ',"z":' .. num(z) ..
        ',"m":' .. (m ~= nil and num(m) or "0") .. '}')
    end
  end
  mespSent = true
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
