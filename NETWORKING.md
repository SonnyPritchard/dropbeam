# Networking — Embedded Tailscale Runtime

DropBeam ships with Tailscale CLI binaries (`tailscale` / `tailscaled`) embedded inside the installer. Users do **not** need to install Tailscale separately.

## How it works

Devices authenticate with the DropBeam backend, receive a Headscale pre-auth key, and join the mesh. The embedded `tailscaled` daemon creates direct WireGuard tunnels between devices for file transfer at full line speed.

The daemon runs in **userspace-networking** mode (`--tun=userspace-networking`):

- **No TUN/kernel module required** — works without root or administrator privileges.
- **No OS routing table changes** — traffic is handled inside the process.
- Uses a private socket path under the app's userData directory, so it never conflicts with a system-installed Tailscale instance.

---

## Licensing

Tailscale is open-source software licensed under the **BSD 3-Clause License**.
Full source code and license text: <https://github.com/tailscale/tailscale>

```
Copyright (c) Tailscale Inc & AUTHORS
All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this
   list of conditions and the following disclaimer in the documentation and/or
   other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors may
   be used to endorse or promote products derived from this software without
   specific prior written permission.
```

---

## OS permissions

### macOS
- **Network access** — to reach the Headscale coordination server and DERP relays.
- **Incoming connections** — to accept file transfers.
- Pre-built Tailscale binaries are signed by Tailscale Inc. macOS Gatekeeper may flag them if the outer app is not notarised. Notarise the app for production releases.

### Windows
- **Firewall prompt** — Windows Firewall may ask on first run to allow `tailscaled.exe` to accept incoming connections. Allow it for mesh networking to work.
- No UAC elevation required (userspace-networking mode).

---

## Security

- Embedded binaries are pinned to a specific Tailscale version (see `TAILSCALE_VERSION` in `.github/workflows/build.yml`).
- Traffic is encrypted end-to-end with WireGuard. Headscale sees device metadata but not file contents.
- Pre-auth keys are single-use and expire after 24 hours.
- Tailscale state is stored per-app in userData (`%APPDATA%\DropBeam\tailscale-runtime\state.conf` on Windows, `~/Library/Application Support/DropBeam/tailscale-runtime/state.conf` on macOS).

---

## Updating the bundled version

1. Change `TAILSCALE_VERSION` in `.github/workflows/build.yml`.
2. Push — CI downloads new binaries and includes them in the build.
3. For local dev: `TAILSCALE_VERSION=x.y.z npm run download-tailscale`.

---

## Infrastructure

- **Headscale server** — self-hosted, runs in WSL alongside the backend. Config at `/etc/headscale/config.yaml`.
- **Backend** — Express API in `backend/` handles auth and proxies Headscale protocol traffic.
- **macOS notarisation** — requires Apple Developer account, set up separately in CI.
- **Code-signing** — both platforms benefit from signing to avoid OS trust prompts.
