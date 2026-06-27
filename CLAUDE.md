# DropBeam

P2P file transfer app. Devices join a Headscale VPN mesh and transfer files directly over WireGuard tunnels — full speed from any location.

## Architecture

DropBeam uses a self-hosted Headscale coordination server to create a Tailscale-compatible mesh network. Each device runs an embedded Tailscale daemon (bundled in the Electron app, no user install needed). Transfers go device-to-device over encrypted WireGuard tunnels — no relay, no cloud, no speed penalty.

```
Device A (Electron + embedded tailscaled)
    |
    |-- registers with backend (JWT auth)
    |-- gets pre-auth key from Headscale
    |-- joins mesh via embedded tailscaled
    |
    '-- WireGuard tunnel ----------- Device B
                                     (same flow)

Backend (Express, port 3001)
    |-- user auth (signup/login, JWT, bcrypt, SQLite)
    |-- device registration (issues Headscale pre-auth keys)
    '-- reverse-proxies all other routes to Headscale (port 8080)
```

## Key paths

- `src/main.js` — Electron main process, signaling, IPC, Tailscale runtime init
- `src/app.js` — Renderer, UI, file transfer logic
- `src/tailscale-runtime.js` — Manages bundled tailscale/tailscaled binaries
- `src/login.html` / `src/login.js` — Auth UI for DropBeam Connect
- `backend/server.js` — Express API + Headscale reverse proxy (port 3001)
- `backend/db.js` — SQLite user store
- `backend/headscale.js` — Headscale REST API wrapper
- `server.js` (root) — Legacy web server mode, not the primary architecture
- `bin/` — Platform-specific tailscale/tailscaled binaries

## Backend

Runs in WSL. Config in `backend/.env`:

- `HEADSCALE_URL` — local Headscale (default http://localhost:8080)
- `HEADSCALE_API_KEY` — Headscale API bearer token
- `JWT_SECRET` — signs user auth tokens
- `PUBLIC_URL` — the URL clients use to reach this backend (must match current public IP)

Headscale config: `/etc/headscale/config.yaml` (root-owned, needs sudo). The `server_url` field must also match the current public IP.

## Running locally

```bash
# Backend (in WSL)
cd backend && node server.js

# Headscale (in WSL, needs sudo)
sudo headscale serve

# Electron app
npm start
```

## Building

```bash
npm run build:win    # Windows NSIS installer
npm run build:mac    # macOS DMG (x64 + arm64)
npm run download-tailscale  # Fetch bundled binaries for dev
```

## Legacy code (not the current architecture)

The codebase still contains LAN-era code that is **not** part of the current architecture:
- mDNS discovery (multicast-dns, SERVICE_TYPE '_dropbeam._tcp.local')
- WebRTC DataChannel transfers (simple-peer, signaling on port 47821)
- Subnet HTTP scanning (fallback discovery)
- `server.js` (root) web server mode with WS signaling
- `web/` directory (Capacitor/browser builds)

This code remains in the repo but the primary transport is now the Headscale VPN mesh.
