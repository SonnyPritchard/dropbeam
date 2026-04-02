# DropBeam 🚀

AirDrop-style P2P file transfer over LAN. Works between any combination of Electron app and web browser — no internet required.

## Features
- 🖥️ **Electron desktop app** (Windows, macOS, Linux)
- 🌐 **Web browser mode** — share a URL, anyone on the LAN can use it
- 🔍 **Auto-discovery** via mDNS (primary) + subnet scan (fallback, for Windows firewall)
- ⚡ **WebRTC data channels** — direct P2P transfer, no server relay
- 🔀 **Cross-compatible** — Electron↔Electron, Electron↔Browser, Browser↔Browser

## Usage

### Electron App
```bash
npm install
npm start
```

### Web Server Mode
```bash
npm install
npm run web
# or: node server.js
```

The server prints your local URLs on startup:
```
🚀 DropBeam Web Server started
────────────────────────────────────────
   http://192.168.1.10:3000
   (also http://localhost:3000)
────────────────────────────────────────
📡 Signaling WS on port 47821
🔍 Discovering peers via mDNS + subnet scan
```

Share the URL (e.g. `http://192.168.1.10:3000`) with anyone on your LAN. They open it in a browser and can immediately send/receive files.

### Cross-Compatibility
All modes discover each other automatically:
- Electron apps + web server instances announce on mDNS and respond to subnet scans
- Signaling uses WebSocket on port **47821** — same protocol everywhere
- WebRTC negotiation is identical regardless of client type

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Discovery: mDNS (primary) + subnet HTTP scan (fallback)    │
│                                                             │
│  Signaling: WebSocket on port 47821                         │
│  - Electron: WS server in main.js                           │
│  - Web: WS server in server.js (also proxies for browsers)  │
│                                                             │
│  Transfer: WebRTC DataChannel (direct P2P)                  │
└─────────────────────────────────────────────────────────────┘
```

### Web Server Signaling Flow
```
Browser ──(WS register)──► server.js:47821
Browser ──(forward msg)──► server.js ──(WS)──► target:47821
target  ──(WS msg)───────► server.js ──(WS)──► Browser
```

## Building

```bash
npm run build:win    # Windows installer
npm run build:mac    # macOS DMG
npm run build:all    # Both
```

## Ports Used
| Port  | Purpose                        |
|-------|--------------------------------|
| 3000  | HTTP (web server mode only)    |
| 47821 | WebSocket signaling (all modes)|
