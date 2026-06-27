# DropBeam

Direct device-to-device file transfer. Devices discover each other via mDNS and transfer files over WebRTC DataChannels — no cloud storage, no file size limits.

## How it works

Devices discover each other on the local network using mDNS (with subnet HTTP scanning as a fallback). A WebSocket signaling server coordinates WebRTC peer connections, and files transfer directly over WebRTC DataChannels.

The codebase includes early integration work for a Headscale/Tailscale mesh (embedded tailscaled, device registration, pre-auth keys), but file transfers currently go through the WebRTC path — the WireGuard tunnel transfer path is not yet wired up.

## Features

- Direct peer-to-peer file transfer over WebRTC DataChannels
- mDNS device discovery (subnet HTTP scan fallback)
- WebSocket signaling server (port 47821)
- Electron app for Windows, macOS, Linux
- Headscale/Tailscale mesh integration in progress (embedded runtime, device registration)

## Quick start

### Electron app
```bash
npm install
npm run download-tailscale
npm start
```

### Web server mode
```bash
node server.js
```

This starts the signaling WebSocket server (port 47821) and serves the web frontend (port 3000).

## Architecture

```
Discovery: mDNS (primary) + subnet HTTP scan (fallback)

Signaling: WebSocket on port 47821
  - Electron: WS server in main.js
  - Web: WS server in server.js

Transfer: WebRTC DataChannel (direct P2P)
```

### Headscale integration (in progress)

The codebase includes scaffolding for a Headscale/Tailscale mesh:
- `src/tailscale-runtime.js` — manages embedded tailscale/tailscaled binaries
- `src/login.html` / `src/login.js` — auth UI for device registration
- Electron main process Tailscale init in `src/main.js`

This will eventually replace WebRTC with WireGuard tunnel transfers, but the transfer path is not yet connected.

## Building

```bash
npm run build:win    # Windows installer
npm run build:mac    # macOS DMG (x64 + arm64)
npm run build:all    # Both
```

Tailscale binaries are bundled via electron-builder `extraResources`.

## Ports

| Port | Purpose |
|------|---------|
| 3000 | Web frontend (server.js) |
| 47821 | WebSocket signaling server |
