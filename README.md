# DropBeam

Direct device-to-device file transfer over a WireGuard mesh. Full speed from any location — no relay servers, no cloud storage, no file size limits.

## How it works

Each device runs an embedded Tailscale daemon that connects to a self-hosted Headscale coordination server. Once authenticated, devices get direct WireGuard tunnels to each other. Files transfer peer-to-peer over these encrypted tunnels at line speed, regardless of where the devices are.

No Tailscale account or install needed — the binaries ship inside the app.

## Features

- Direct WireGuard tunnels between devices (no relay overhead)
- Embedded Tailscale runtime (no user install required)
- Self-hosted Headscale coordination (you own the infrastructure)
- JWT-based user auth with device registration
- Works across any network — LAN, WAN, NAT, whatever
- Electron app for Windows, macOS, Linux

## Quick start

### Electron app
```bash
npm install
npm run download-tailscale
npm start
```

### Backend (runs in WSL)
```bash
cd backend
npm install
node server.js
```

Requires Headscale running on the same machine:
```bash
sudo headscale serve
```

## Architecture

```
Electron App
  |-- embedded tailscaled (userspace networking, no root)
  |-- authenticates with backend (JWT)
  |-- registers device, gets Headscale pre-auth key
  '-- joins mesh, transfers files over WireGuard tunnels

Backend (port 3001)
  |-- Express + SQLite + JWT auth
  |-- issues Headscale pre-auth keys for device registration
  '-- reverse-proxies Headscale (port 8080) for Tailscale protocol

Headscale (port 8080)
  '-- coordinates the mesh, manages device keys and routing
```

## Building

```bash
npm run build:win    # Windows installer
npm run build:mac    # macOS DMG (x64 + arm64)
npm run build:all    # Both
```

Tailscale binaries are bundled via electron-builder `extraResources`.

## Configuration

Backend config (`backend/.env`):
- `PUBLIC_URL` — public URL for this backend (must match current public IP)
- `HEADSCALE_URL` — Headscale address (default http://localhost:8080)
- `HEADSCALE_API_KEY` — API bearer token
- `JWT_SECRET` — signs auth tokens

Headscale config (`/etc/headscale/config.yaml`):
- `server_url` — must match `PUBLIC_URL` above

## Ports

| Port | Purpose |
|------|---------|
| 3001 | Backend API (auth + Headscale proxy) |
| 8080 | Headscale coordination server |
