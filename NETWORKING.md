# Networking — Bundled Tailscale Runtime

DropBeam ships with the Tailscale CLI binaries (`tailscale` / `tailscaled`) embedded
inside the installer. Users do **not** need to install Tailscale separately.

---

## How it works

| Layer | Technology | Notes |
|---|---|---|
| LAN discovery | mDNS + subnet scan | No internet required |
| File transfer | WebRTC data channels | Direct peer-to-peer via STUN/TURN |
| Mesh overlay | Tailscale (embedded) | Headscale coordination server |

The embedded `tailscaled` daemon is started in **userspace-networking** mode
(`--tun=userspace-networking`). This means:

- **No TUN/kernel module required** — works without root or administrator privileges.
- **No OS routing table changes** — traffic is handled inside the process.
- The daemon uses a private socket path under the app's userData directory, so it never
  conflicts with a system-installed Tailscale instance.

---

## Licensing

Tailscale is open-source software licensed under the **BSD 3-Clause License**.
Full source code and license text: <https://github.com/tailscale/tailscale>

By bundling these binaries, DropBeam complies with the BSD 3-Clause terms:
the original copyright notice is reproduced below.

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

## OS permissions required

### macOS
- **Network access** — to reach the Headscale coordination server and DERP relays.
- **Incoming connections** — to accept Taildrop file transfers.
- No special entitlements beyond those already present in a standard Electron app.
- Note: pre-built Tailscale binaries are signed by Tailscale Inc. When re-distributed
  inside DropBeam, macOS Gatekeeper may flag them if the outer app is not notarised.
  For production releases, notarise the app via Apple's notarisation service.

### Windows
- **Firewall prompt** — Windows Firewall may ask on first run to allow `tailscaled.exe`
  to accept incoming connections. The user should allow it for mesh networking to work.
- No UAC elevation is required because userspace-networking mode is used.

---

## Security considerations

- The embedded binaries are pinned to a specific Tailscale version (see `TAILSCALE_VERSION`
  in `.github/workflows/build.yml`). Update this value and rebuild to pick up security patches.
- Tailscale traffic is encrypted end-to-end with WireGuard. The coordination server
  (Headscale) sees device metadata but not file contents.
- The pre-auth keys used for device registration are single-use and expire.
- The Tailscale state file is stored in the app's userData directory
  (`%APPDATA%\DropBeam\tailscale-runtime\state.conf` on Windows,
   `~/Library/Application Support/DropBeam/tailscale-runtime/state.conf` on macOS).

---

## Updating the bundled version

1. Change `TAILSCALE_VERSION` in `.github/workflows/build.yml`.
2. Push — CI will download the new binaries and include them in the build artifacts.
3. For local dev: `TAILSCALE_VERSION=x.y.z npm run download-tailscale`.

---

## What remains manual

- **Headscale server** — DropBeam Connect still requires a running Headscale server
  (configured via `DROPBEAM_SERVER`). The embedded runtime only replaces the client-side
  Tailscale install; the server-side infrastructure is separate.
- **macOS notarisation** — must be set up separately in CI with an Apple Developer
  account for production releases.
- **Code-signing** — both platforms benefit from signing to avoid OS trust prompts.
