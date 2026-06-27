# Building the Tailscale Bridge for Android

The bridge wraps Tailscale's `tsnet` package into an Android `.aar` library
using `gomobile`. The DropBeam Android app loads this library to embed a
Tailscale node — no separate Tailscale app required.

## Prerequisites

- Go 1.22+
- Android SDK (API 26+)
- Android NDK (install via `sdkmanager "ndk;27.0.12077973"`)
- `ANDROID_HOME` and `ANDROID_NDK_HOME` env vars set

## Build steps

```bash
# Install gomobile
go install golang.org/x/mobile/cmd/gomobile@latest
go install golang.org/x/mobile/cmd/gobind@latest

# Initialize gomobile (downloads NDK toolchains)
gomobile init

# Build the .aar from this directory
cd tailscale-bridge
go mod tidy
gomobile bind -target=android -androidapi 26 -o libtailscale.aar .

# Copy to the Android app's libs directory
cp libtailscale.aar ../android/app/libs/
```

## What it provides

The `.aar` exposes these functions to Kotlin/Java:

| Function | Description |
|---|---|
| `Bridge.tsnetStart(dataDir, controlURL, authKey, hostname)` | Start embedded Tailscale node |
| `Bridge.tsnetStop()` | Stop the node |
| `Bridge.tsnetGetIP()` | Get this node's Tailscale IP |
| `Bridge.tsnetGetPeers()` | Get JSON array of mesh peers |
| `Bridge.tsnetStartHTTPServer(port)` | Start HTTP file-receive server on mesh |
| `Bridge.dialPeer(ip, port)` | TCP dial through the mesh |

## File transfer protocol

Instead of `tailscale file cp` (CLI-only), the bridge runs an HTTP server
on the Tailscale interface:

- **Send**: `POST http://<peerIP>:47822/receive` with multipart form data
- **Receive**: The HTTP server saves files to `ReceiveDir` (set before starting)

Both Android and PC apps use this same HTTP protocol for transfers.

## Updating the PC app

The Electron app currently uses `tailscale file cp`. To make it compatible
with Android peers, add an HTTP receive endpoint on port 47822 and send
files via HTTP POST instead of the CLI command. See `src/main.js` for the
integration point (~line 423).
