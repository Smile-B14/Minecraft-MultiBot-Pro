'use strict'

const mineflayer = require('mineflayer')
const readline = require('readline')
const {
  pathfinder,
  Movements,
  goals: { GoalFollow, GoalNearXZ }
} = require('mineflayer-pathfinder')

const CFG = {
  maxBots: 10000,
  joinGap: 6500,
  retry: 10000,
  throttleRetry: 12000,
  authWindow: 30000,
  authRetryGap: 2500,
  followRadius: 18,
  followDistance: 2,
  hitDistance: 3.1,
  aiTick: 1400,
  wanderMin: 4,
  wanderMax: 10
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: Boolean(process.stdout.isTTY)
})

const states = new Map()
const botNames = new Set()
const queue = []
let queueSeq = 0
let queueTimer = null
let nextConnectAt = 0
let controlMode = false
let promptVisible = false
let shuttingDown = false
let ipBanned = false
let aiEnabled = true
let hitEnabled = true
let logsEnabled = false
let autoAuthEnabled = true
let authPassword = 'thematic'

const ask = q => new Promise(resolve => rl.question(q, resolve))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const text = v => {
  if (typeof v === 'string') return v
  try { return JSON.stringify(v) } catch { return String(v) }
}
const versionLabel = v => v || 'auto'
const normalizeVersion = v => {
  v = String(v || '').trim()
  return !v || v.toLowerCase() === 'auto' ? null : v
}

function log(...parts) {
  const line = parts.map(text).join(' ')
  if (!controlMode || !promptVisible || !process.stdout.isTTY) {
    process.stdout.write(line + '\n')
    return
  }
  readline.clearLine(process.stdout, 0)
  readline.cursorTo(process.stdout, 0)
  process.stdout.write(line + '\n')
  if (typeof rl._refreshLine === 'function') rl._refreshLine()
  else rl.prompt(true)
}

function prompt() {
  if (!controlMode || shuttingDown) return
  promptVisible = true
  rl.prompt()
}

function classifyKick(reason) {
  const s = text(reason).toLowerCase()
  if (s.includes('multiplayer.disconnect.ip_banned') || s.includes('ip banned') || s.includes('ip_banned')) return 'ip_banned'
  if (s.includes('multiplayer.disconnect.banned') || s.includes('you are banned') || s.includes('banned from this server')) return 'player_banned'
  if (s.includes('connection throttled') || s.includes('please wait before reconnecting')) return 'throttled'
  return 'other'
}

function priority(reason) {
  if (reason === 'manual rejoin' || reason === 'restart') return 0
  if (reason === 'retry' || reason === 'connection throttle') return 1
  return 2
}

function removeQueued(state) {
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].state === state) queue.splice(i, 1)
  state.queued = false
}

function enqueue(state, delay = 0, reason = 'retry') {
  if (shuttingDown || ipBanned || state.intentionalStop || state.permanentStop || state.connected || state.connecting || state.queued) return false
  state.queued = true
  state.queueReason = reason
  queue.push({ state, readyAt: Date.now() + Math.max(0, delay), p: priority(reason), seq: queueSeq++ })
  log(`[${state.username}] queued (${reason})`)
  scheduleQueue()
  return true
}

function scheduleQueue() {
  if (queueTimer) clearTimeout(queueTimer)
  queueTimer = null
  if (shuttingDown || ipBanned || !queue.length) return
  const now = Date.now()
  const earliest = Math.min(...queue.map(x => x.readyAt))
  queueTimer = setTimeout(runQueue, Math.max(0, Math.max(earliest, nextConnectAt) - now))
}

function runQueue() {
  queueTimer = null
  if (shuttingDown || ipBanned || !queue.length) return
  const now = Date.now()
  if (now < nextConnectAt) return scheduleQueue()

  const ready = queue.filter(x => x.readyAt <= now && !x.state.permanentStop && !x.state.intentionalStop)
  if (!ready.length) return scheduleQueue()
  ready.sort((a, b) => a.p - b.p || a.readyAt - b.readyAt || a.seq - b.seq)
  const entry = ready[0]
  queue.splice(queue.indexOf(entry), 1)
  entry.state.queued = false
  nextConnectAt = Date.now() + CFG.joinGap
  connectBot(entry.state)
  scheduleQueue()
}

function stopAI(state) {
  if (state.aiTimer) clearInterval(state.aiTimer)
  state.aiTimer = null
  try { state.bot?.pathfinder?.setGoal(null) } catch {}
  try { state.bot?.clearControlStates() } catch {}
  state.followingId = null
}

function markPlayerBanned(state) {
  state.permanentStop = true
  state.stopReason = 'player_banned'
  state.connected = false
  state.connecting = false
  removeQueued(state)
  stopAI(state)
  log(`[${state.username}] PLAYER BANNED - retries stopped`)
}

function markIpBanned() {
  if (ipBanned) return
  ipBanned = true
  if (queueTimer) clearTimeout(queueTimer)
  queueTimer = null
  log('IP BAN DETECTED. All automatic reconnects stopped.')
  log('After server-side unban: resetban, then rejoin all')
  for (const state of states.values()) {
    removeQueued(state)
    if (!state.connected) {
      state.permanentStop = true
      state.stopReason = 'ip_banned'
    }
  }
}

function resetban() {
  ipBanned = false
  let n = 0
  for (const state of states.values()) {
    if (state.stopReason === 'ip_banned') {
      state.permanentStop = false
      state.stopReason = null
      state.lastKick = ''
      state.lastError = ''
      n++
    }
  }
  nextConnectAt = Date.now()
  log(`Cleared LOCAL IP-ban state for ${n} bot(s). This does not remove a server ban.`)
}

function resetplayer(name) {
  const state = states.get(String(name).toLowerCase())
  if (!state) return log(`Unknown bot: ${name}`)
  if (state.stopReason !== 'player_banned') return log(`[${state.username}] is not marked player-banned.`)
  state.permanentStop = false
  state.stopReason = null
  state.lastKick = ''
  state.lastError = ''
  log(`[${state.username}] LOCAL player-ban state cleared.`)
}

function resetall() {
  ipBanned = false
  let n = 0
  for (const state of states.values()) {
    if (state.stopReason === 'ip_banned' || state.stopReason === 'player_banned') {
      state.permanentStop = false
      state.stopReason = null
      state.intentionalStop = false
      state.lastKick = ''
      state.lastError = ''
      n++
    }
  }
  nextConnectAt = Date.now()
  log(`Cleared LOCAL ban state for ${n} bot(s). Active server bans are not bypassed.`)
}

function resetAuth(state) {
  state.authUntil = Date.now() + CFG.authWindow
  state.auth = { registerAttempts: 0, loginAttempts: 0, lastRegister: 0, lastLogin: 0 }
}

function systemLikeMessage(msg) {
  // Ignore vanilla-style <player> chat. Plugin/system messages are still scanned.
  return !/^\s*<[^>]+>\s*/.test(msg)
}

function loginPrompt(msg) {
  return /\/login\b/i.test(msg) || /\blogin\b/i.test(msg) || /\blog\s+in\b/i.test(msg)
}

function registerPrompt(msg) {
  return /\/register\b/i.test(msg) || /\bregister\b/i.test(msg) || /\bregistration\b/i.test(msg) || /\breg\b/i.test(msg)
}

function handleAuth(state, raw) {
  if (!autoAuthEnabled || !state.connected || Date.now() > state.authUntil) return
  const msg = String(raw || '').trim()
  if (!msg || !systemLikeMessage(msg)) return
  const now = Date.now()

  if (registerPrompt(msg) && now - state.auth.lastRegister >= CFG.authRetryGap) {
    state.auth.lastRegister = now
    state.auth.registerAttempts++
    const onePass = state.auth.registerAttempts > 1 || /\/register\s+<password>\s*$/i.test(msg)
    const cmd = onePass ? `/register ${authPassword}` : `/register ${authPassword} ${authPassword}`
    try { state.bot.chat(cmd); log(`[${state.username}] AUTO-AUTH → ${cmd.replaceAll(authPassword, '********')}`) } catch {}
    return
  }

  if (loginPrompt(msg) && now - state.auth.lastLogin >= CFG.authRetryGap) {
    state.auth.lastLogin = now
    state.auth.loginAttempts++
    const cmd = `/login ${authPassword}`
    try { state.bot.chat(cmd); log(`[${state.username}] AUTO-AUTH → /login ********`) } catch {}
  }
}

function nearestHuman(bot) {
  return bot.nearestEntity(e => e.type === 'player' && e.username && e.username !== bot.username && !botNames.has(e.username.toLowerCase()))
}

function wander(state) {
  const bot = state.bot
  if (!bot?.entity || !bot.pathfinder) return
  const dist = CFG.wanderMin + Math.random() * (CFG.wanderMax - CFG.wanderMin)
  const angle = Math.random() * Math.PI * 2
  const x = Math.floor(bot.entity.position.x + Math.cos(angle) * dist)
  const z = Math.floor(bot.entity.position.z + Math.sin(angle) * dist)
  try { bot.pathfinder.setGoal(new GoalNearXZ(x, z, 1)) } catch {}
  state.followingId = null
  state.nextWander = Date.now() + 4500 + Math.floor(Math.random() * 5000)
}

function startAI(state) {
  stopAI(state)
  if (!aiEnabled || !state.bot?.entity) return
  const bot = state.bot
  const movements = new Movements(bot)
  movements.canDig = false
  movements.allow1by1towers = false
  movements.maxDropDown = 3
  bot.pathfinder.setMovements(movements)
  state.nextWander = Date.now() + 1000
  state.lastHit = 0

  state.aiTimer = setInterval(async () => {
    if (!aiEnabled || !state.connected || state.intentionalStop || state.permanentStop || !state.bot?.entity) return
    const target = nearestHuman(bot)
    if (target) {
      const d = bot.entity.position.distanceTo(target.position)
      if (d <= CFG.followRadius) {
        if (state.followingId !== target.id) {
          try { bot.pathfinder.setGoal(new GoalFollow(target, CFG.followDistance), true); state.followingId = target.id } catch {}
        }
        if (bot.entity.onGround && Math.random() < 0.10) {
          try { bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 220) } catch {}
        }
        if (hitEnabled && d <= CFG.hitDistance && Date.now() - state.lastHit > 1300 && Math.random() < 0.40) {
          state.lastHit = Date.now()
          try { await bot.lookAt(target.position.offset(0, 1.4, 0), true); bot.attack(target, true) } catch {}
        }
        return
      }
    }
    if (state.followingId !== null || Date.now() >= state.nextWander) wander(state)
  }, CFG.aiTick)
}

function clearDuration(state) {
  if (state.stopTimer) clearTimeout(state.stopTimer)
  state.stopTimer = null
  state.deadline = null
}

function startDuration(state) {
  if (state.minutes <= 0 || state.deadline) return
  state.deadline = Date.now() + state.minutes * 60000
  state.stopTimer = setTimeout(() => {
    state.intentionalStop = true
    stopAI(state)
    removeQueued(state)
    log(`[${state.username}] Time finished. Leaving.`)
    try { state.bot?.quit('Finished') } catch {}
  }, state.minutes * 60000)
}

function connectBot(state) {
  if (shuttingDown || ipBanned || state.intentionalStop || state.permanentStop || state.connected || state.connecting) return
  state.connecting = true
  state.lastKick = ''
  state.lastError = ''
  log(`[${state.username}] Connecting to ${state.port ? `${state.host}:${state.port}` : state.host} (${versionLabel(state.version)})...`)

  const opts = { host: state.host, username: state.username, auth: 'offline', keepAlive: true, hideErrors: true }
  if (state.port) opts.port = state.port
  if (state.version) opts.version = state.version

  let bot
  try { bot = mineflayer.createBot(opts) }
  catch (err) {
    state.connecting = false
    log(`[${state.username}] CREATE ERROR: ${err.message}`)
    return enqueue(state, CFG.retry, 'retry')
  }

  state.bot = bot
  bot.loadPlugin(pathfinder)

  bot.once('spawn', () => {
    state.connecting = false
    state.connected = true
    state.detectedVersion = bot.version || state.version || null
    state.restartRequested = false
    state.lastKick = ''
    state.lastError = ''
    resetAuth(state)
    log(`[${state.username}] JOINED${state.detectedVersion ? ` (${state.detectedVersion})` : ''}`)
    startDuration(state)
    startAI(state)
  })

  bot.on('messagestr', msg => {
    handleAuth(state, msg)
    if (logsEnabled) {
      const s = String(msg || '').trim()
      if (s) log(`[SERVER → ${state.username}] ${s}`)
    }
  })

  bot.on('kicked', reason => {
    state.lastKick = reason
    const type = classifyKick(reason)
    if (type === 'ip_banned') { log(`[${state.username}] KICKED: IP BANNED`); return markIpBanned() }
    if (type === 'player_banned') { log(`[${state.username}] KICKED: PLAYER BANNED`); return markPlayerBanned(state) }
    if (type === 'throttled') return log(`[${state.username}] KICKED: connection throttled`)
    log(`[${state.username}] KICKED: ${text(reason)}`)
  })

  bot.on('error', err => {
    state.lastError = err.code || err.message
    log(`[${state.username}] ERROR: ${state.lastError}`)
  })

  bot.on('end', reason => {
    stopAI(state)
    state.connected = false
    state.connecting = false
    if (state.bot === bot) state.bot = null
    if (shuttingDown || ipBanned || state.intentionalStop || state.permanentStop) return
    if (state.deadline && Date.now() >= state.deadline) { state.intentionalStop = true; return }
    if (state.restartRequested) { state.restartRequested = false; return enqueue(state, 0, 'restart') }
    const kick = classifyKick(state.lastKick)
    if (kick === 'ip_banned') return markIpBanned()
    if (kick === 'player_banned') return markPlayerBanned(state)
    enqueue(state, kick === 'throttled' ? CFG.throttleRetry : CFG.retry, kick === 'throttled' ? 'connection throttle' : 'retry')
  })
}

function manualRejoin(target) {
  if (ipBanned) return log('Blocked: IP-ban state is active. Remove the server ban, then run resetban.')
  const list = target.toLowerCase() === 'all' ? [...states.values()] : [states.get(target.toLowerCase())].filter(Boolean)
  if (!list.length) return log(`Unknown bot: ${target}`)
  let n = 0
  for (const s of list) {
    if (s.permanentStop || s.connected || s.connecting) continue
    removeQueued(s)
    clearDuration(s)
    s.intentionalStop = false
    s.lastKick = ''
    s.lastError = ''
    if (enqueue(s, 0, 'manual rejoin')) n++
  }
  log(`Rejoin queued for ${n} bot(s).`)
}

function restart(target) {
  const list = target.toLowerCase() === 'all' ? [...states.values()] : [states.get(target.toLowerCase())].filter(Boolean)
  if (!list.length) return log(`Unknown bot: ${target}`)
  for (const s of list) {
    if (s.permanentStop) continue
    removeQueued(s)
    clearDuration(s)
    s.intentionalStop = false
    s.restartRequested = true
    if (s.bot) { try { s.bot.quit('Restart') } catch {} }
    else enqueue(s, 0, 'restart')
  }
}

function setVersion(rest) {
  const args = rest.split(/\s+/).filter(Boolean)
  if (!args.length) {
    log('===== VERSIONS =====')
    for (const s of states.values()) log(`${s.username}: configured=${versionLabel(s.version)}, detected=${s.detectedVersion || '-'}`)
    return log('====================')
  }
  if (args.length === 1) {
    const v = normalizeVersion(args[0])
    for (const s of states.values()) s.version = v
    return log(`All bots version set to ${versionLabel(v)} for next connection.`)
  }
  const target = args[0].toLowerCase()
  const v = normalizeVersion(args[1])
  if (target === 'all') {
    for (const s of states.values()) s.version = v
    return log(`All bots version set to ${versionLabel(v)} for next connection.`)
  }
  const s = states.get(target)
  if (!s) return log(`Unknown bot: ${args[0]}`)
  s.version = v
  log(`[${s.username}] version set to ${versionLabel(v)} for next connection.`)
}

async function sendAll(message) {
  const online = [...states.values()].filter(s => s.connected && s.bot)
  if (!online.length) return log('No bots online.')
  for (const s of online) {
    try { s.bot.chat(message); log(`[${s.username}] → ${message}`); await sleep(450) }
    catch (err) { log(`[${s.username}] CHAT ERROR: ${err.message}`) }
  }
}

async function sendOne(name, message) {
  const s = states.get(name.toLowerCase())
  if (!s?.connected || !s.bot) return log(`${name} is not online.`)
  try { s.bot.chat(message); log(`[${s.username}] → ${message}`) }
  catch (err) { log(`[${s.username}] CHAT ERROR: ${err.message}`) }
}

function status(s) {
  if (s.stopReason === 'ip_banned') return 'IP BANNED / STOPPED'
  if (s.stopReason === 'player_banned') return 'PLAYER BANNED / STOPPED'
  if (s.permanentStop) return 'STOPPED'
  if (s.connected) return 'ONLINE'
  if (s.connecting) return 'CONNECTING'
  if (s.queued) return `QUEUED (${s.queueReason})`
  if (s.intentionalStop) return 'FINISHED'
  return 'OFFLINE'
}

function showBots() {
  log('===== BOTS =====')
  for (const s of states.values()) log(`${s.username}: ${status(s)} | version=${versionLabel(s.version)}${s.detectedVersion ? `/${s.detectedVersion}` : ''}`)
  log('================')
}

function help() {
  log(`
==============================
BOT CONTROL

all <message>
one <name> <message>
list

rejoin all | rejoin <name>
restart all | restart <name>

version
version auto | version 1.21.11
version all auto | version all 1.21.11
version <name> auto | version <name> 1.21.11

resetban
resetplayer <name>
resetall

auth on | auth off
authpass <password>

ai on | ai off
hit on | hit off
logs on | logs off

help
quit
==============================`)
}

function startControls() {
  controlMode = true
  rl.setPrompt('BOT > ')
  help()
  prompt()
  rl.on('line', async input => {
    promptVisible = false
    const line = input.trim()
    if (!line) return prompt()
    const space = line.indexOf(' ')
    const cmd = (space < 0 ? line : line.slice(0, space)).toLowerCase()
    const rest = space < 0 ? '' : line.slice(space + 1).trim()

    if (cmd === 'all') { if (rest) await sendAll(rest); else log('Use: all <message>') }
    else if (cmd === 'one') {
      const p = rest.indexOf(' ')
      if (p < 0) log('Use: one <botname> <message>')
      else await sendOne(rest.slice(0, p), rest.slice(p + 1).trim())
    } else if (cmd === 'list') showBots()
    else if (cmd === 'rejoin') rest ? manualRejoin(rest) : log('Use: rejoin all | rejoin <name>')
    else if (cmd === 'restart') rest ? restart(rest) : log('Use: restart all | restart <name>')
    else if (cmd === 'version') setVersion(rest)
    else if (cmd === 'resetban') resetban()
    else if (cmd === 'resetplayer') rest ? resetplayer(rest) : log('Use: resetplayer <name>')
    else if (cmd === 'resetall') resetall()
    else if (cmd === 'auth') {
      if (rest === 'on') { autoAuthEnabled = true; log('Auto-auth ON') }
      else if (rest === 'off') { autoAuthEnabled = false; log('Auto-auth OFF') }
      else log('Use: auth on | auth off')
    } else if (cmd === 'authpass') {
      if (!rest) log('Use: authpass <password>')
      else { authPassword = rest; log('Auto-auth password updated.') }
    } else if (cmd === 'ai') {
      if (rest === 'on') { aiEnabled = true; for (const s of states.values()) if (s.connected) startAI(s); log('AI ON') }
      else if (rest === 'off') { aiEnabled = false; for (const s of states.values()) stopAI(s); log('AI OFF') }
      else log('Use: ai on | ai off')
    } else if (cmd === 'hit') {
      if (rest === 'on' || rest === 'off') { hitEnabled = rest === 'on'; log(`Punching ${hitEnabled ? 'ON' : 'OFF'}`) }
      else log('Use: hit on | hit off')
    } else if (cmd === 'logs') {
      if (rest === 'on' || rest === 'off') { logsEnabled = rest === 'on'; log(`Server logs ${logsEnabled ? 'ON' : 'OFF'}`) }
      else log('Use: logs on | logs off')
    } else if (cmd === 'help') help()
    else if (cmd === 'quit') return quitAll()
    else log('Unknown command. Type: help')
    prompt()
  })
}

function quitAll() {
  if (shuttingDown) return
  shuttingDown = true
  promptVisible = false
  process.stdout.write('\nDisconnecting bots...\n')
  if (queueTimer) clearTimeout(queueTimer)
  queue.length = 0
  for (const s of states.values()) {
    s.intentionalStop = true
    clearDuration(s)
    stopAI(s)
    try { s.bot?.quit('Stopped from controller') } catch {}
  }
  setTimeout(() => process.exit(0), 700)
}

async function main() {
  console.log('\n=== MINECRAFT MULTIBOT PRO ===\n')
  const host = (await ask('Server IP / hostname: ')).trim()
  const portText = (await ask('Port (blank = Java SRV/auto): ')).trim()
  const versionText = (await ask('Minecraft version (blank/auto = auto-detect): ')).trim()
  const namesText = await ask(`Bot names separated by commas (max ${CFG.maxBots}): `)
  const minutesText = (await ask('Minutes to stay (0 = until quit): ')).trim()

  if (!host) return console.log('Server hostname is required.')
  let port = null
  if (portText) {
    port = Number(portText)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return console.log('Invalid port.')
  }
  const version = normalizeVersion(versionText)
  const minutes = Number(minutesText || 0)
  if (!Number.isFinite(minutes) || minutes < 0) return console.log('Invalid minutes.')

  const seen = new Set()
  const names = namesText.split(',').map(x => x.trim()).filter(Boolean).filter(name => {
    const key = name.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (!names.length) return console.log('Enter at least one bot name.')
  if (names.length > CFG.maxBots) return console.log(`Maximum ${CFG.maxBots} bots in this build.`)
  const invalid = names.filter(name => !/^[A-Za-z0-9_]{3,16}$/.test(name))
  if (invalid.length) return console.log(`Invalid usernames: ${invalid.join(', ')}`)

  for (const username of names) {
    botNames.add(username.toLowerCase())
    states.set(username.toLowerCase(), {
      username, host, port, version, detectedVersion: null, minutes,
      bot: null, connected: false, connecting: false, queued: false, queueReason: '',
      intentionalStop: false, permanentStop: false, stopReason: null, restartRequested: false,
      stopTimer: null, deadline: null, aiTimer: null, lastKick: '', lastError: '',
      followingId: null, nextWander: 0, lastHit: 0, authUntil: 0,
      auth: { registerAttempts: 0, loginAttempts: 0, lastRegister: 0, lastLogin: 0 }
    })
  }

  console.log(`\nServer: ${host}${port ? `:${port}` : ' (SRV/auto port)'}`)
  console.log(`Version: ${versionLabel(version)}`)
  console.log(`Bots: ${names.length}`)
  console.log(`Connection gap: ${CFG.joinGap / 1000}s`)
  console.log(`Auto-auth: ON for first ${CFG.authWindow / 1000}s after each join\n`)

  for (const s of states.values()) enqueue(s, 0, 'initial join')
  startControls()
}

process.on('SIGINT', quitAll)
process.on('SIGTERM', quitAll)

main().catch(err => {
  console.error(err)
  process.exit(1)
})
