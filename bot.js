'use strict'

const mineflayer = require('mineflayer')
const readline = require('readline')
const { pathfinder, Movements, goals: { GoalFollow } } = require('mineflayer-pathfinder')
const { SocksProxyAgent } = require('socks-proxy-agent')
const https = require('https')

const CFG = {
  joinGap: 2000, // 2 seconds. Safe because we use different proxies.
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

// --- Auto Proxy Fetcher ---
async function fetchProxies() {
  console.log('Fetching public SOCKS5 proxies...')
  return new Promise((resolve) => {
    https.get('https://api.proxyscrape.com/v2/?request=getproxies&protocol=socks5&timeout=10000&country=all&ssl=all&anonymity=all', (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        const list = data.split('\r\n').filter(Boolean).map(p => {
          const [host, port] = p.split(':')
          return { type: 'socks5', host, port: parseInt(port), username: '', password: '' }
        })
        resolve(list)
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
  connectBot(entry.state)
  scheduleQueue()
}

function nearestHuman(bot) {
  return bot.nearestEntity(e => e.type === 'player' && e.username && e.username !== bot.username && !botNames.has(e.username.toLowerCase()))
}

function startAI(state) {
  if (state.aiTimer) clearInterval(state.aiTimer)
  const bot = state.bot
  if (!bot?.entity) return
  
  const movements = new Movements(bot)
  movements.canDig = false
  movements.allow1by1towers = false
  movements.maxDropDown = 3
  bot.pathfinder.setMovements(movements)

  state.aiTimer = setInterval(async () => {
    if (!aiEnabled || !state.connected || !state.bot?.entity) return
    
    const target = nearestHuman(bot)
    if (target) {
      const d = bot.entity.position.distanceTo(target.position)
      if (d <= CFG.followRadius) {
        try { bot.pathfinder.setGoal(new GoalFollow(target, CFG.followDistance), true) } catch {}
        
        // Anti-Cheat Bypass: Randomized hit intervals and slight look offset
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
  }, CFG.aiTick)
}

function handleAuth(state, raw) {
  if (!state.connected) return
  const msg = String(raw || '').trim().toLowerCase()
  if (!msg) return

  if (msg.includes('/register') || msg.includes('please register')) {
    try { state.bot.chat(`/register ${CFG.authPassword} ${CFG.authPassword}`) } catch {}
  } else if (msg.includes('/login') || msg.includes('please login')) {
    try { state.bot.chat(`/login ${CFG.authPassword}`) } catch {}
  }
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
    opts.agent = new SocksProxyAgent({ host: state.proxy.host, port: state.proxy.port, type: 5 })
  }

  let bot
  try { bot = mineflayer.createBot(opts) }
  catch (err) {
    log(`[${state.username}] CREATE ERROR: ${err.message}`)
    state.connecting = false
    return enqueue(state, 5000, 'retry')
  }

  state.bot = bot
  bot.loadPlugin(pathfinder)

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
  bot.on('error', err => log(`[${state.username}] ERROR: ${err.message}`))

  bot.on('end', () => {
    if (state.aiTimer) clearInterval(state.aiTimer)
    state.connected = false
    state.connecting = false
    state.bot = null
    
    if (!state.permanentStop) {
      // Assign a NEW proxy on retry to ensure we don't reuse a banned IP
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
stopspawn  (stops infinite generation)
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
    rl.prompt()
  })
}

async function main() {
  console.log('\n=== MINECRAFT SWARM AUTO-PROXY v3.1 ===\n')
  
  // 1. Fetch proxies automatically
  proxyList = await fetchProxies()
  console.log(`Auto-loaded ${proxyList.length} SOCKS5 proxies.`)

  // 2. Ask user for server details
  targetHost = (await ask('Target Server IP: ')).trim()
  const portText = (await ask('Port (blank = auto): ')).trim()
  const versionText = (await ask('Version (blank = auto): ')).trim()
  const countText = (await ask('How many bots to generate? (0 = infinite until stopped): ')).trim()

  if (portText) targetPort = Number(portText)
  if (versionText && versionText.toLowerCase() !== 'auto') targetVersion = versionText

  // 3. Generate initial batch
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

main().catch(err => console.error(err))
