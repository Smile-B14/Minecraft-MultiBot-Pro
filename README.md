# Minecraft MultiBot Pro

Cross-platform Minecraft Java multi-bot controller built with Mineflayer. Runs in Termux on Android and on Windows, macOS, and Linux with Node.js.

> Use only on servers you own or have permission to test. The controller keeps a global connection gap, respects server bans, and does not bypass active server protections.

## Features

- Up to 10000 offline/cracked-mode bot usernames
- Java-style SRV/automatic port lookup when port is left blank
- Minecraft version auto-detection by default
- Global or per-bot version selection
- Priority reconnect scheduler so retries do not sit behind the entire initial queue
- `rejoin`, `restart`, `resetban`, `resetplayer`, and `resetall` controls
- 30-second auth-plugin detection after each join
- Detects `login`, `log in`, `/login`, `register`, `registration`, `reg`, and `/register`
- Default auth password `thematic`
- Sends `/login thematic`
- Sends `/register thematic thematic`, with a one-password fallback on repeated registration prompts
- Random wandering and jumping
- Follows nearby non-bot players
- Optional nearby punching
- Preserves partially typed terminal commands while logs appear

## Requirements

- Node.js 22+
- Git for clone-based installation

Dependencies are pinned in `package.json`:

- `mineflayer` 4.37.1
- `mineflayer-pathfinder` 2.4.5

## Termux / Android

Install Node.js and Git once:

```bash
pkg update -y && pkg install git nodejs-lts -y
```

Clone, install, and run:

```bash
git clone https://github.com/Smile-B14/Minecraft-MultiBot-Pro.git && cd Minecraft-MultiBot-Pro && npm install && npm start
```

Later runs:

```bash
cd ~/Minecraft-MultiBot-Pro && npm start
```

## Windows / macOS / Linux

Install Node.js 22+ and Git, then:

```bash
git clone https://github.com/Smile-B14/Minecraft-MultiBot-Pro.git
cd Minecraft-MultiBot-Pro
npm install
npm start
```

## Startup

The controller asks for:

```text
Server IP / hostname:
Port (blank = Java SRV/auto):
Minecraft version (blank/auto = auto-detect):
Bot names separated by commas (max 30):
Minutes to stay (0 = until quit):
```

### Port

Leave the port blank for a normal Java hostname that provides an SRV record. The script omits `port` from the Mineflayer connection options so the underlying Minecraft protocol stack can perform Java-style service lookup.

If you use a raw IP address or a hostname without an SRV record and the server uses a nonstandard port, enter the port manually.

### Version

Leave version blank or enter `auto` for automatic detection. You can also force a version such as `1.21.11`.

## Auto register / login

For the first 30 seconds after each successful join, the controller scans plugin/system messages for authentication cues. Vanilla-style `<player> message` chat is ignored by the auth detector.

Registration cues include `register`, `registration`, `reg`, and `/register`. Login cues include `login`, `log in`, and `/login`.

Default commands:

```text
/register thematic thematic
/login thematic
```

Change the password at runtime:

```text
authpass MyPassword
```

Toggle automatic authentication:

```text
auth off
auth on
```

## Commands

```text
all <message>
one <name> <message>
list

rejoin all
rejoin <name>
restart all
restart <name>

version
version auto
version 1.21.11
version all auto
version all 1.21.11
version <name> auto
version <name> 1.21.11

resetban
resetplayer <name>
resetall

auth on
auth off
authpass <password>

ai on
ai off
hit on
hit off
logs on
logs off

help
quit
```

`resetban`, `resetplayer`, and `resetall` only clear the controller's local stopped state after you remove the actual ban on the Minecraft server. They do not bypass active bans.

## Check syntax

```bash
npm run check
```

## Notes

- The default connection gap is 6.5 seconds to avoid hammering the same server.
- Auto version mode is recommended unless a server/proxy requires a specific protocol version.
- Movement/pathfinding behavior depends on server terrain and protocol support.
