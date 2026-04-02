# DropBeam ⚡

**AirDrop-style P2P file transfer for your local network.**  
Devices auto-discover each other via mDNS. Drag files → pick a device → files transfer directly via WebRTC. No internet, no servers, no codes.

---

## Run (development)

```bash
cd dropbeam
npm install
npm start
```

## Build

```bash
# Windows (.exe installer via NSIS)
npm run build:win

# macOS (.dmg)
npm run build:mac

# Both
npm run build:all
```

Outputs go to `dist/`.

---

## How it works

| Layer | Tech |
|-------|------|
| App shell | Electron 29 |
| LAN discovery | `multicast-dns` (mDNS/Bonjour) |
| P2P transfer | Browser-native WebRTC (RTCDataChannel) |
| Signaling | In-app HTTP server (Express) on each instance — no external relay |
| STUN | Google's free STUN servers |

### Flow
1. Each instance starts a local HTTP signaling server (port 47821+)
2. mDNS announces the device and its signaling port to the LAN
3. Sender drags file onto a device card → WebRTC offer/answer exchanged via HTTP
4. ICE negotiation completes (STUN-assisted) → direct P2P data channel opens
5. File chunks stream over the data channel → saved to receiver's Downloads folder

---

## Architecture

```
src/
  main.js      — Electron main process: mDNS, signaling server, file I/O
  preload.js   — Context bridge (secure IPC between main ↔ renderer)
  index.html   — UI shell
  app.js       — Renderer: WebRTC logic, UI interactions
assets/
  icon.*       — App icons (replace with proper ones for release)
```

---

## Notes

- **WSL/Linux**: mDNS multicast may need a firewall rule: `sudo ufw allow 5353/udp`
- **Windows**: Windows Firewall will prompt on first run to allow the signaling port
- **Native rebuild**: No native modules used — fully cross-platform JS
- **Large files**: Currently loads file into memory before transfer. For files >500MB, a streaming approach is recommended.

