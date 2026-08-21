'use strict'

const mineflayer = require('mineflayer')
const readline = require('readline')
const { pathfinder, Movements, goals: { GoalFollow } } = require('mineflayer-pathfinder')
const { SocksProxyAgent } = require('socks-proxy-agent')
const https = require('https')

const CFG = {
  joinGap: 2000, 
  followRadius: 40,
  followDistance: 2,
  hitDistance: 3.5,
  aiTick: 1000,
  authPassword: '12345'
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
let proxyList = []
let proxyIndex = 0

const ask = q => new Promise(resolve => rl.question(q, resolve))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const text = v => typeof v === 'string' ? v : JSON.stringify(v)

// Global crash preventers
process.on('uncaughtException', (err) => {
  log(`CRASH PREVENTED (Uncaught Exception): ${err.message}`)
})
process.on('unhandledRejection', (err) => {
  log(`CRASH PREVENTED (Unhandled Rejection): ${err}`)
})

// --- Input Validation ---
async function askValid(question, validator) {
  while (true) {
    const res = (await ask(question)).trim()
    const err = validator(res)
    if (err === true) return res
    console.log(`Invalid input: ${err}`)
  }
}

// --- Auto Proxy Fetcher ---
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
            return { host, port: parseInt(port) }
          }).filter(p => p.host && p.port)
          resolve(list)
        } catch (e) {
          resolve([])
        }
      })
    }).on('error', () => resolve([]))
  })
}

function getNextProxy() {
  if (!proxyList.length) return null
  const proxy = proxyList[proxyIndex % proxyList.length]
  proxyIndex++
  return proxy
}

function buildProxyUrl(proxy) {
  if (!proxy) return null
  return `socks5://${proxy.host}:${proxy.port}`
}

// --- Random Username Generator ---
const nameParts = {
  pre: ['xX', 'Pro', 'Itz', 'The', 'Real', 'Just', 'i', 'Snipe'],
  mid: ['Steve', 'Alex', 'Pixel', 'Block', 'Craft', 'Mine', 'Epic', 'God', 'Dark', 'Shadow', 'Cool', 'Smart'],
  suf: ['Xx', 'YT', '99', '123', '_', 'Pro', 'GG', '420', '69', '777']
}
function generateRealisticName() {
  let name = ''
  const pattern = Math.floor(Math.random() * 4)
  if (pattern === 0) name = `${nameParts.pre[Math.floor(Math.random()*nameParts.pre.length)]}${nameParts.mid[Math.floor(Math.random()*nameParts.mid.length)]}`
  else if (pattern === 1) name = `${nameParts.mid[Math.floor(Math.random()*nameParts.mid.length)]}${nameParts.suf[Math.floor(Math.random()*nameParts.suf.length)]}`
  else if (pattern === 2) name = `${nameParts.mid[Math.floor(Math.random()*nameParts.mid.length)]}_${Math.floor(Math.random() * 999)}`
  else name = `${nameParts.pre[Math.floor(Math.random()*nameParts.pre.length)]}${nameParts.mid[Math.floor(Math.random()*nameParts.mid.length)]}${nameParts.suf[Math.floor(Math.random()*nameParts.suf.length)]}`

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
  nextConnectAt = Date.now() + CFG.joinGap
  
  try {
    connectBot(entry.state)
  } catch (e) {
    log(`Queue error connecting ${entry.state.username}: ${e.message}. Rotating proxy and retrying...`)
    entry.state.proxy = getNextProxy()
    enqueue(entry.state, 3000, 'queue error retry')
  }
  scheduleQueue()
}

function nearestHuman(bot) {
  try {
    return bot.nearestEntity(e => e.type === 'player' && e.username && e.username !== bot.username && !botNames.has(e.username.toLowerCase()))
  } catch {
    return null
  }
}

function startAI(state) {
  if (state.aiTimer) clearInterval(state.aiTimer)
  const bot = state.bot
  if (!bot?.entity) return
  
  try {
    const movements = new Movements(bot)
    movements.canDig = false
    movements.allow1by1towers = false
    movements.maxDropDown = 3
    bot.pathfinder.setMovements(movements)
  } catch (e) {
    log(`[${state.username}] AI movement setup error: ${e.message}`)
  }

  state.aiTimer = setInterval(async () => {
    try {
      if (!aiEnabled || !state.connected || !state.bot?.entity) return
      
      const target = nearestHuman(bot)
      if (target) {
        const d = bot.entity.position.distanceTo(target.position)
        if (d <= CFG.followRadius) {
          try { bot.pathfinder.setGoal(new GoalFollow(target, CFG.followDistance), true) } catch {}
          
          if (hitEnabled && d <= CFG.hitDistance && Date.now() - state.lastHit > (600 + Math.random() * 600)) {
            state.lastHit = Date.now()
            const offsetX = (Math.random() - 0.5) * 0.4
            const offsetY = (Math.random() - 0.5) * 0.4
            try {
              await bot.lookAt(target.position.offset(offsetX, 1.4 + offsetY, offsetX), true)
              bot.attack(target, true)
            } catch {}
          }
        }
      }
    } catch (e) {
      // Silently ignore AI tick errors to prevent crash
    }
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

  const opts = { 
    host: targetHost, 
    username: state.username, 
    auth: 'offline', 
    keepAlive: true, 
    hideErrors: true,
    port: targetPort,
    version: targetVersion
  }

  if (state.proxy) {
    try {
      const proxyUrl = buildProxyUrl(state.proxy)
      if (proxyUrl) {
        opts.agent = new SocksProxyAgent(proxyUrl)
      }
    } catch (e) {
      log(`[${state.username}] Proxy agent error, rotating...`)
      state.connecting = false
      state.proxy = getNextProxy()
      return enqueue(state, 1000, 'proxy error retry')
    }
  }

  let bot
  try { 
    bot = mineflayer.createBot(opts) 
  }
  catch (err) {
    log(`[${state.username}] CREATE ERROR: ${err.message}. Retrying in 5s...`)
    state.connecting = false
    state.proxy = getNextProxy()
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

  bot.on('kicked', reason => log(`[${state.username}] KICKED: ${text(reason)}`))
  bot.on('error', err => {
    log(`[${state.username}] ERROR: ${err.message}`)
  })

  bot.on('end', () => {
    try { if (state.aiTimer) clearInterval(state.aiTimer) } catch {}
    state.connected = false
    state.connecting = false
    state.bot = null
    
    if (!state.permanentStop) {
      state.proxy = getNextProxy()
      enqueue(state, 5000, 'retry')
    } else {
      states.delete(state.username.toLowerCase())
      botNames.delete(state.username.toLowerCase())
    }
  })
}

async function sendAll(message) {
  const online = [...states.values()].filter(s => s.connected && s.bot)
  for (const s of online) {
    try { s.bot.chat(message); await sleep(300) } catch {}
  }
  log(`Sent message to ${online.length} bots.`)
}

function startSpam(message, interval) {
  if (spamTimer) clearInterval(spamTimer)
  spamTimer = setInterval(() => sendAll(message), interval)
  log(`Spamming every ${interval}ms.`)
}

function stopSpam() {
  if (spamTimer) {
    clearInterval(spamTimer)
    spamTimer = null
    log('Spam stopped.')
  }
}

function startInfiniteSpawn() {
  if (infiniteSpawn) return
  infiniteSpawn = true
  log('Infinite spawn mode enabled. Generating bots continuously...')
  
  spawnInterval = setInterval(() => {
    const name = generateRealisticName()
    if (!botNames.has(name.toLowerCase())) {
      botNames.add(name.toLowerCase())
      const state = {
        username: name, bot: null, connected: false, connecting: false, queued: false,
        intentionalStop: false, permanentStop: false, lastHit: 0, proxy: getNextProxy()
      }
      states.set(name.toLowerCase(), state)
      enqueue(state, 0, 'infinite spawn')
    }
  }, 2000)
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
  log(`Total: ${states.size} | Online: ${online} | Connecting: ${connecting}`)
}

function help() {
  log(`
=== BOT CONTROL (CMD ONLY) ===
list
spam <interval_ms> <message>
stopspam
stopspawn
ai on | ai off
hit on | hit off
logs on | logs off
quit
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
        if (p < 0) log('Use: spam <interval_ms> <message>')
        else startSpam(rest.slice(p + 1).trim(), parseInt(rest.slice(0, p)))
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
    } catch (e) {
      log(`Command error: ${e.message}`)
    }
    rl.prompt()
  })
}

async function main() {
  console.log('\n=== MINECRAFT SWARM AUTO-PROXY v3.2 (Crash-Proof) ===\n')
  
  proxyList = await fetchProxies()
  console.log(`Auto-loaded ${proxyList.length} SOCKS5 proxies.`)

  // Validated Inputs
  targetHost = await askValid('Target Server IP: ', (v) => v.length > 2 ? true : 'IP must be at least 3 characters.')
  
  const portText = await askValid('Port (blank = auto): ', (v) => {
    if (!v) return true
    const p = Number(v)
    if (!Number.isInteger(p) || p < 1 || p > 65535) return 'Port must be a number between 1 and 65535.'
    return true
  })
  if (portText) targetPort = Number(portText)

  const versionText = await askValid('Version (blank = auto): ', (v) => true)
  if (versionText && versionText.toLowerCase() !== 'auto') targetVersion = versionText

  const countText = await askValid('How many bots to generate? (0 = infinite until stopped): ', (v) => {
    if (!v && v !== '0') return 'Please enter a number.'
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0) return 'Must be a positive integer or 0.'
    return true
  })

  const count = parseInt(countText || '0')
  if (count === 0) {
    startInfiniteSpawn()
  } else {
    for (let i = 0; i < count; i++) {
      const name = generateRealisticName()
      botNames.add(name.toLowerCase())
      const state = { username: name, bot: null, connected: false, connecting: false, queued: false, intentionalStop: false, permanentStop: false, lastHit: 0, proxy: getNextProxy() }
      states.set(name.toLowerCase(), state)
      enqueue(state, i * 500, 'generated')
    }
  }

  console.log(`\nTarget: ${targetHost}${targetPort ? ':' + targetPort : ''}`)
  console.log(`Starting swarm. Proxies are automatically rotating.\n`)
  
  startControls()
}

process.on('SIGINT', () => {
  log('Exiting...')
  process.exit(0)
})

main().catch(err => {
  console.error('Fatal startup error:', err)
})
