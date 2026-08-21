# Hardened Safe v3

This branch preserves the existing non-evasion multi-bot controls while documenting and fixing compatibility/setup issues found during review.

## Important review findings

- Current Mineflayer 4.37.1 requires Node.js 22 or newer.
- `mineflayer.createBot({ agent })` does **not** route the raw Minecraft TCP connection through a SOCKS proxy. `agent` in node-minecraft-protocol is for HTTP/Yggdrasil authentication traffic. Raw proxying requires the protocol `connect` hook and a socket implementation.
- Blank `port` and `version` should be omitted from the options object so Mineflayer can use its normal defaults / auto-detection behavior.
- Authentication prompts need a short cooldown and a limited post-spawn window to prevent repeated `/register` or `/login` loops.
- Reconnect queues need duplicate guards and one global scheduler so one bot cannot reserve multiple future slots.
- Clean shutdown should cancel queue/AI/duration timers and disconnect all clients before exit.

## What is intentionally not merged

This branch does not add rotating public proxies to evade server IP throttles or bans, infinite join flooding, automated chat spam, or anti-cheat bypass logic. Those behaviors can be used to overwhelm third-party servers or bypass access controls.

## Termux setup

```bash
pkg update -y
pkg install git nodejs-lts -y
git clone -b hardened-safe-v3 https://github.com/Smile-B14/Minecraft-MultiBot-Pro.git
cd Minecraft-MultiBot-Pro
npm install
npm start
```

If you already cloned the repository:

```bash
cd ~/Minecraft-MultiBot-Pro
git fetch origin
git switch hardened-safe-v3
npm install
npm start
```

## Windows / macOS / Linux

Install Node.js 22+ and Git, then:

```bash
git clone -b hardened-safe-v3 https://github.com/Smile-B14/Minecraft-MultiBot-Pro.git
cd Minecraft-MultiBot-Pro
npm install
npm start
```

## Updating later

```bash
git pull
npm install
npm start
```

## Version and port behavior

Leave the Minecraft version blank or enter `auto` to let Mineflayer detect the server version. Leave the port blank when the normal Java/default/SRV behavior is appropriate; provide an explicit port for servers that require one.

## Safety note

Use the project only on servers you own or have permission to automate. The reconnect spacing is intentionally retained rather than bypassing connection throttling.
