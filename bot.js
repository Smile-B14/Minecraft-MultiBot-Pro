'use strict'

const mineflayer = require('mineflayer')
const readline = require('readline')
const { pathfinder, Movements, goals: { GoalFollow, GoalNearXZ } } = require('mineflayer-pathfinder')
const { SocksProxyAgent } = require('socks-proxy-agent')
const https = require('https')

const CFG = {
  minJoinGap: 3800,
  maxJoinGap: 5600,
  followRadius: 40,
  followDistance: 2,
  hitDistance: 3.5,
  aiTick: 400,
  authPassword: '12345',
  chatDelay: 1500 // 1.5 seconds delay between each bot chatting to bypass spam filters
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

let aiEnabled = true
let hitEnabled = true
let logsEnabled = false
let spamTimer = null
let infiniteSpawn = false
let spawnInterval = null

let targetHost = ''
let targetPort = null
let targetVersion = null

const proxyPool = []
const deadProxiesGlobal = new Set()
const usedProxiesForServer = new Map()
const bannedProxiesForServer = new Map()

const ask = q => new Promise(resolve => rl.question(q, resolve))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const text = v => typeof v === 'string' ? v : JSON.stringify(v)

process.on('uncaughtException', (err) => log(`CRASH PREVENTED (Uncaught): ${err.message}`))
process.on('unhandledRejection', (err) => log(`CRASH PREVENTED (Rejection): ${err}`))

async function askValid(question, validator) {
  while (true) {
    const res = (await ask(question)).trim()
    const err = validator(res)
    if (err === true) return res
    console.log(`Invalid input: ${err}`)
  }
}

async function fetchProxies() {
  console.log('Fetching public SOCKS5 proxies...')
  return new Promise((resolve) => {
    https.get('https://api.proxyscrape.com/v2/?request=getproxies&protocol=socks5&timeout=10000&country=all&ssl=all&anonymity=all', (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const list = data.split('\r\n').filter(Boolean).map(p => {
            const [host, port] = p.split(':')
            if (host && port) return { host, port: parseInt(port), proxyUrl: `socks5://${host}:${port}` }
            return null
          }).filter(Boolean)
          resolve(list)
        } catch (e) { resolve([]) }
      })
    }).on('error', () => resolve([]))
  })
}

function getProxyForServer(serverHost) {
  const used = usedProxiesForServer.get(serverHost) || new Set()
  const banned = bannedProxiesForServer.get(serverHost) || new Set()
  const available = proxyPool.filter(p => !deadProxiesGlobal.has(p.proxyUrl) && !banned.has(p.proxyUrl) && !used.has(p.proxyUrl))
  
  if (available.length === 0) {
    const recyclable = proxyPool.filter(p => !deadProxiesGlobal.has(p.proxyUrl) && !banned.has(p.proxyUrl))
    if (recyclable.length > 0) return recyclable[Math.floor(Math.random() * recyclable.length)]
    const anyAlive = proxyPool.filter(p => !deadProxiesGlobal.has(p.proxyUrl))
    if (anyAlive.length > 0) return anyAlive[Math.floor(Math.random() * anyAlive.length)]
    return null
  }
  const proxy = available[Math.floor(Math.random() * available.length)]
  used.add(proxy.proxyUrl)
  usedProxiesForServer.set(serverHost, used)
  return proxy
}

function banProxy(serverHost, proxy, reason) {
  if (!proxy) return
  deadProxiesGlobal.add(proxy.proxyUrl)
  const banned = bannedProxiesForServer.get(serverHost) || new Set()
  banned.add(proxy.proxyUrl)
  bannedProxiesForServer.set(serverHost, banned)
  log(`Proxy ${proxy.host}:${proxy.port} blacklisted (${reason}). Total dead: ${deadProxiesGlobal.size}`)
}

function generateRealisticName() {
  const prefixes = ['xX', 'Itz', 'Pro', 'The', 'i', '_', 'Mr', 'Lil', 'xX_', 'The_']
  const names = ['Steve', 'Alex', 'Pixel', 'Block', 'Craft', 'Mine', 'Epic', 'God', 'Dark', 'Shadow', 'Cool', 'Smart', 'Sniper', 'Gamer', 'Noob', 'King', 'Boss', 'PvP', 'Slayer', 'Zombie', 'Creeper']
  const suffixes = ['Xx', '_Xx', 'YT', '99', '123', '_', 'Pro', 'GG', '420', '69', '777', 'x', '_']
  let name = ''
  const r = Math.random()
  if (r < 0.25) name = `xX${names[Math.floor(Math.random()*names.length)]}Xx`
  else if (r < 0.5) name = `${names[Math.floor(Math.random()*names.length)]}_${Math.floor(Math.random() * 9999)}`
  else if (r < 0.75) name = `${names[Math.floor(Math.random()*names.length)]}${suffixes[Math.floor(Math.random()*suffixes.length)]}`
  else name = `${prefixes[Math.floor(Math.random()*prefixes.length)]}${names[Math.floor(Math.random()*names.length)]}`
  if (Math.random() < 0.4 && name.length < 13) name += Math.floor(Math.random() * 999)
  name = name.replace(/[^A-Za-z0-9_]/g, '')
  if (name.length < 4) name += Math.floor(Math.random() * 9999)
  if (name.length > 16) name = name.substring(0, 16)
  return name
}

function log(...parts) {
  const line = parts.map(text).join(' ')
  readline.clearLine(process.stdout, 0)
  readline.cursorTo(process.stdout, 0)
  process.stdout.write(line + '\n')
  rl.prompt(true)
}

function enqueue(state, delay = 0, reason = 'retry') {
  state.queued = true
  state.queueReason = reason
  queue.push({ state, readyAt: Date.now() + Math.max(0, delay), seq: queueSeq++ })
  scheduleQueue()
}

function scheduleQueue() {
  if (queueTimer) clearTimeout(queueTimer)
  queueTimer = null
  if (!queue.length) return
  const now = Date.now()
  const earliest = Math.min(...queue.map(x => x.readyAt))
  queueTimer = setTimeout(runQueue, Math.max(0, Math.max(earliest, nextConnectAt) - now))
}

function runQueue() {
  queueTimer = null
  if (!queue.length) return
  const now = Date.now()
  if (now < nextConnectAt) return scheduleQueue()

  const ready = queue.filter(x => x.readyAt <= now)
  if (!ready.length) return scheduleQueue()
  const entry = ready[0]
  queue.splice(queue.indexOf(entry), 1)
  entry.state.queued = false
  const joinDelay = CFG.minJoinGap + Math.random() * (CFG.maxJoinGap - CFG.minJoinGap)
  nextConnectAt = Date.now() + joinDelay
  try { connectBot(entry.state) } 
  catch (e) {
    log(`Queue error: ${e.message}. Retrying...`)
    entry.state.proxy = getProxyForServer(targetHost)
    enqueue(entry.state, 3000, 'queue error retry')
  }
  scheduleQueue()
}

function nearestHuman(bot) {
  try { return bot.nearestEntity(e => e.type === 'player' && e.username && e.username !== bot.username && !botNames.has(e.username.toLowerCase())) } 
  catch { return null }
}

function startAI(state) {
  try {
    if (state.aiTimer) clearInterval(state.aiTimer)
    const bot = state.bot
    if (!bot?.entity) return
    const movements = new Movements(bot)
    movements.canDig = false
    movements.allow1by1towers = false
    movements.maxDropDown = 3
    bot.pathfinder.setMovements(movements)
  } catch (e) { log(`[${state.username}] AI setup error: ${e.message}`) }

  state.aiTimer = setInterval(async () => {
    try {
      if (!aiEnabled || !state.connected || !state.bot?.entity) return
      const bot = state.bot
      const target = nearestHuman(bot)
      if (target) {
        const d = bot.entity.position.distanceTo(target.position)
        if (d <= CFG.followRadius) {
          try { bot.pathfinder.setGoal(new GoalFollow(target, CFG.followDistance), true) } catch {}
          if (hitEnabled && d <= CFG.hitDistance && Date.now() - state.lastHit > (400 + Math.random() * 400)) {
            state.lastHit = Date.now()
            const offsetX = (Math.random() - 0.5) * 0.5
            const offsetY = (Math.random() - 0.5) * 0.5
            try {
              await bot.lookAt(target.position.offset(offsetX, 1.4 + offsetY, offsetX), true)
              bot.attack(target, true)
            } catch {}
          }
          return
        }
      } else {
        if (!bot.pathfinder.isMoving() && Math.random() < 0.3) {
          const x = bot.entity.position.x + (Math.random() * 20 - 10)
          const z = bot.entity.position.z + (Math.random() * 20 - 10)
          try { bot.pathfinder.setGoal(new GoalNearXZ(x, z, 2)) } catch {}
        }
        if (Math.random() < 0.1) {
          try { bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 300) } catch {}
        }
      }
    } catch (e) {}
  }, CFG.aiTick)
}

function handleAuth(state, raw) {
  try {
    if (!state.connected) return
    const msg = String(raw || '').trim().toLowerCase()
    if (!msg) return
    if (msg.includes('/register') || msg.includes('please register')) {
      try { state.bot.chat(`/register ${CFG.authPassword} ${CFG.authPassword}`) } catch {}
    } else if (msg.includes('/login') || msg.includes('please login')) {
      try { state.bot.chat(`/login ${CFG.authPassword}`) } catch {}
    }
  } catch {}
}

function connectBot(state) {
  state.connecting = true
  const proxyTag = state.proxy ? `[P]` : `[D]`
  log(`[${state.username}] ${proxyTag} Connecting to ${targetHost}...`)

  const opts = { host: targetHost, username: state.username, auth: 'offline', keepAlive: true, hideErrors: true, port: targetPort, version: targetVersion }
  if (state.proxy) {
    try { opts.agent = new SocksProxyAgent(state.proxy.proxyUrl) } 
    catch (e) {
      banProxy(targetHost, state.proxy, 'Agent Init Error')
      state.connecting = false
      state.proxy = getProxyForServer(targetHost)
      return enqueue(state, 1000, 'proxy init error retry')
    }
  }

  let bot
  try { bot = mineflayer.createBot(opts) }
  catch (err) {
    log(`[${state.username}] CREATE ERROR: ${err.message}. Retrying...`)
    state.connecting = false
    state.proxy = getProxyForServer(targetHost)
    return enqueue(state, 5000, 'retry')
  }

  state.bot = bot
  try { bot.loadPlugin(pathfinder) } catch {}

  bot.once('spawn', () => {
    state.connecting = false
    state.connected = true
    log(`[${state.username}] JOINED. Starting AI...`)
    startAI(state)
  })

  bot.on('messagestr', msg => {
    handleAuth(state, msg)
    if (logsEnabled) log(`[CHAT -> ${state.username}] ${msg}`)
  })

  bot.on('kicked', reason => {
    const reasonStr = text(reason).toLowerCase()
    log(`[${state.username}] KICKED: ${text(reason)}`)
    if (reasonStr.includes('whitelist') || reasonStr.includes('not whitelisted') || reasonStr.includes('banned')) {
      log(`[${state.username}] Stopping retries (Whitelist/Ban detected).`)
      state.permanentStop = true
      if (reasonStr.includes('ip_banned') || reasonStr.includes('ip banned')) {
        banProxy(targetHost, state.proxy, 'IP Banned by Server')
      }
    }
  })

  bot.on('error', err => {
    log(`[${state.username}] ERROR: ${err.message}`)
    if (state.proxy && (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.message.includes('socks') || err.message.includes('proxy'))) {
      banProxy(targetHost, state.proxy, 'Connection Error')
    }
  })

  bot.on('end', () => {
    try { if (state.aiTimer) clearInterval(state.aiTimer) } catch {}
    state.connected = false
    state.connecting = false
    state.bot = null
    if (!state.permanentStop) {
      state.proxy = getProxyForServer(targetHost)
      enqueue(state, 3000, 'retry')
    } else {
      states.delete(state.username.toLowerCase())
      botNames.delete(state.username.toLowerCase())
    }
  })
}

async function sendAll(message) {
  const online = [...states.values()].filter(s => s.connected && s.bot)
  for (const s of online) {
    try { s.bot.chat(message); await sleep(CFG.chatDelay) } catch {} // 1.5s delay between each bot
  }
  log(`Finished sending message to ${online.length} bots.`)
}

function startSpam(message, interval) {
  if (spamTimer) clearInterval(spamTimer)
  spamTimer = setInterval(() => sendAll(message), interval)
  log(`Spamming EVERY ${interval}ms. (Each bot will wait ${CFG.chatDelay}ms before chatting to bypass limits)`)
}

function stopSpam() {
  if (spamTimer) { clearInterval(spamTimer); spamTimer = null; log('Spam stopped.') }
}

function startInfiniteSpawn() {
  if (infiniteSpawn) return
  infiniteSpawn = true
  log('Infinite spawn mode enabled. Generating bots continuously...')
  spawnInterval = setInterval(() => {
    try {
      const name = generateRealisticName()
      if (!botNames.has(name.toLowerCase())) {
        botNames.add(name.toLowerCase())
        const state = { username: name, bot: null, connected: false, connecting: false, queued: false, intentionalStop: false, permanentStop: false, lastHit: 0, proxy: getProxyForServer(targetHost) }
        states.set(name.toLowerCase(), state)
        enqueue(state, 0, 'infinite spawn')
      }
    } catch (e) { log(`Spawn gen error: ${e.message}`) }
  }, 1500)
}

function stopSpawn() {
  if (spawnInterval) clearInterval(spawnInterval)
  infiniteSpawn = false
  log('Infinite spawn stopped. Existing bots will remain.')
}

function showBots() {
  let online = 0, connecting = 0
  for (const s of states.values()) {
    if (s.connected) online++
    else if (s.connecting) connecting++
  }
  log(`Total: ${states.size} | Online: ${online} | Connecting: ${connecting} | Dead Proxies: ${deadProxiesGlobal.size}`)
}

function help() {
  log(`
=== BOT CONTROL (CMD ONLY) ===
list                      -> Shows how many bots are online/connecting
spam <ms> <message>       -> Bots spam chat. Example: spam 5000 Hello!
                            (5000 = wait 5 seconds between spam waves)
stopspam                  -> Stops the chat spam
stopspawn                 -> Stops infinite bot generation
ai on | ai off            -> Toggles following and wandering
hit on | hit off          -> Toggles attacking players
logs on | logs off        -> Toggles server chat logging in console
quit                      -> Disconnects all bots and exits
==============================`)
}

function startControls() {
  rl.setPrompt('BOT > ')
  rl.prompt()
  rl.on('line', async input => {
    const line = input.trim()
    if (!line) return rl.prompt()
    const space = line.indexOf(' ')
    const cmd = (space < 0 ? line : line.slice(0, space)).toLowerCase()
    const rest = space < 0 ? '' : line.slice(space + 1).trim()

    try {
      if (cmd === 'list') showBots()
      else if (cmd === 'spam') {
        const p = rest.indexOf(' ')
        if (p < 0) log('Use: spam <interval_ms> <message> (Example: spam 5000 Hello)')
        else {
          const interval = parseInt(rest.slice(0, p))
          if (isNaN(interval) || interval < 1000) log('Interval must be a number >= 1000. Example: spam 5000 Hello')
          else startSpam(rest.slice(p + 1).trim(), interval)
        }
      }
      else if (cmd === 'stopspam') stopSpam()
      else if (cmd === 'stopspawn') stopSpawn()
      else if (cmd === 'ai') { aiEnabled = rest === 'on'; log(`AI ${aiEnabled ? 'ON' : 'OFF'}`) }
      else if (cmd === 'hit') { hitEnabled = rest === 'on'; log(`Hitting ${hitEnabled ? 'ON' : 'OFF'}`) }
      else if (cmd === 'logs') { logsEnabled = rest === 'on'; log(`Logs ${logsEnabled ? 'ON' : 'OFF'}`) }
      else if (cmd === 'help') help()
      else if (cmd === 'quit') {
        log('Disconnecting all...')
        for (const s of states.values()) { try { s.bot?.quit() } catch {} }
        process.exit(0)
      }
      else log('Unknown command. Type: help')
    } catch (e) { log(`Command error: ${e.message}`) }
    rl.prompt()
  })
}

async function main() {
  console.log('\n=== MINECRAFT SWARM AUTO-PROXY v5.2 ===\n')
  const fetched = await fetchProxies()
  proxyPool.push(...fetched)
  console.log(`Auto-loaded ${proxyPool.length} SOCKS5 proxies.`)

  targetHost = await askValid('Target Server IP: ', (v) => v.length > 2 ? true : 'IP must be at least 3 characters.')
  const portText = await askValid('Port (blank = auto): ', (v) => {
    if (!v) return true
    const p = Number(v)
    if (!Number.isInteger(p) || p < 1 || p > 65535) return 'Port must be 1-65535.'
    return true
  })
  if (portText) targetPort = Number(portText)
  const versionText = await askValid('Version (blank = auto): ', (v) => true)
  if (versionText && versionText.toLowerCase() !== 'auto') targetVersion = versionText

  const countText = await askValid('How many bots to generate? (0 = infinite): ', (v) => {
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0) return 'Must be positive or 0.'
    return true
  })
  
  const count = parseInt(countText || '0')
  if (count === 0) startInfiniteSpawn()
  else {
    for (let i = 0; i < count; i++) {
      const name = generateRealisticName()
      botNames.add(name.toLowerCase())
      const state = { username: name, bot: null, connected: false, connecting: false, queued: false, intentionalStop: false, permanentStop: false, lastHit: 0, proxy: getProxyForServer(targetHost) }
      states.set(name.toLowerCase(), state)
      enqueue(state, i * 500, 'generated')
    }
  }

  console.log(`\nTarget: ${targetHost}${targetPort ? ':' + targetPort : ''}`)
  console.log(`Join Delay: ${CFG.minJoinGap/1000}s - ${CFG.maxJoinGap/1000}s (Randomized)`)
  console.log(`Type 'help' in the console to see commands.\n`)
  startControls()
}

process.on('SIGINT', () => { log('Exiting...'); process.exit(0) })
main().catch(err => console.error('Fatal startup error:', err))
