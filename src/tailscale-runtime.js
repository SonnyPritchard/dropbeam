/**
 * tailscale-runtime.js
 *
 * Manages the bundled tailscale / tailscaled binaries shipped inside DropBeam.
 * Users do NOT need to install Tailscale separately.
 *
 * The daemon is started in --tun=userspace-networking mode so it requires no
 * root / administrator privileges and does not create a kernel TUN device.
 * A unique socket path is used so the embedded daemon never conflicts with a
 * system-installed Tailscale instance.
 */

'use strict';

const { execFile, spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Lazy-load Electron's `app` so this module can be required before app is ready.
let _electronApp = null;
function getApp() {
  if (!_electronApp) _electronApp = require('electron').app;
  return _electronApp;
}

class TailscaleRuntime {
  constructor() {
    this.daemon      = null;
    this.socketPath  = null;
    this.statePath   = null;
    this.tailscaleBin  = null;
    this.tailscaledBin = null;
    this.ready       = false;
    this._initPromise = null;
  }

  // ── Binary resolution ────────────────────────────────────────────────────────

  _getBinDir() {
    const electronApp = getApp();
    if (electronApp.isPackaged) {
      // electron-builder copies extraResources into process.resourcesPath/bin
      return path.join(process.resourcesPath, 'bin');
    }
    // Development: binaries sit under project-root/bin/<platform>/
    const plat = process.platform === 'win32' ? 'win'
               : process.platform === 'darwin' ? 'mac'
               : 'linux';
    return path.join(__dirname, '..', 'bin', plat);
  }

  _getBinaryNames() {
    return process.platform === 'win32'
      ? { cli: 'tailscale.exe', daemon: 'tailscaled.exe' }
      : { cli: 'tailscale',     daemon: 'tailscaled'     };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  /**
   * Initialise the embedded runtime. Safe to call multiple times — returns the
   * same promise on repeated calls. Resolves when the daemon is responsive.
   */
  init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit();
    return this._initPromise;
  }

  async _doInit() {
    const binDir = this._getBinDir();
    const { cli, daemon } = this._getBinaryNames();
    this.tailscaleBin  = path.join(binDir, cli);
    this.tailscaledBin = path.join(binDir, daemon);

    if (!fs.existsSync(this.tailscaleBin) || !fs.existsSync(this.tailscaledBin)) {
      throw new Error(
        `Tailscale runtime binaries not found in: ${binDir}\n` +
        `Run "node scripts/download-tailscale.js" to fetch them (dev) or ` +
        `check the CI packaging step (production).`
      );
    }

    // Ensure executable bit on unix
    if (process.platform !== 'win32') {
      try { fs.chmodSync(this.tailscaleBin,  0o755); } catch (_) {}
      try { fs.chmodSync(this.tailscaledBin, 0o755); } catch (_) {}
    }

    // Per-app state dir — completely separate from any system Tailscale install.
    const tsDir = path.join(getApp().getPath('userData'), 'tailscale-runtime');
    fs.mkdirSync(tsDir, { recursive: true });

    this.statePath  = path.join(tsDir, 'state.conf');
    this.socketPath = process.platform === 'win32'
      ? '\\\\.\\pipe\\DropBeamTailscaled'
      : path.join(tsDir, 'tailscaled.sock');

    await this._startDaemon();
    this.ready = true;
    console.log('[ts-runtime] Ready — socket:', this.socketPath);
  }

  async _startDaemon() {
    return new Promise((resolve, reject) => {
      const args = [
        '--state',  this.statePath,
        '--socket', this.socketPath,
        '--tun',    'userspace-networking',
        '--port',   '0',   // OS picks a free UDP port
      ];

      console.log('[ts-runtime] Starting tailscaled…');

      this.daemon = spawn(this.tailscaledBin, args, {
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.daemon.stdout.on('data', d => console.log('[tailscaled]', d.toString().trim()));
      this.daemon.stderr.on('data', d => console.log('[tailscaled]', d.toString().trim()));

      this.daemon.on('error', err => {
        console.error('[ts-runtime] spawn error:', err.message);
        reject(err);
      });

      this.daemon.on('exit', code => {
        if (code !== 0 && code !== null) {
          console.warn('[ts-runtime] tailscaled exited with code', code);
        }
        this.ready  = false;
        this.daemon = null;
      });

      // Poll until the daemon accepts CLI commands (max ~15 s).
      let attempts = 0;
      const poll = () => {
        this._runCli(['status'], 3000)
          .then(() => resolve())
          .catch(() => {
            if (++attempts < 30) setTimeout(poll, 500);
            else reject(new Error('tailscaled did not become ready within 15 s'));
          });
      };
      // Give the process a moment to bind its socket before first poll.
      setTimeout(poll, 800);
    });
  }

  /**
   * Gracefully stop the embedded daemon.
   * Calls `tailscale down` first so the device is cleanly deregistered,
   * then terminates the tailscaled process.
   */
  stop() {
    if (!this.daemon) return;
    this._runCli(['down'], 3000)
      .catch(() => {})
      .finally(() => {
        if (this.daemon) {
          this.daemon.kill('SIGTERM');
          this.daemon = null;
        }
        this.ready = false;
      });
  }

  // ── CLI helpers ──────────────────────────────────────────────────────────────

  /**
   * Run a tailscale CLI command against the embedded daemon.
   * @param {string[]} args    — e.g. ['status', '--json']
   * @param {number}   timeout — ms (default 30 000)
   * @returns {Promise<string>} stdout
   */
  _runCli(args, timeout = 30000) {
    return new Promise((resolve, reject) => {
      execFile(
        this.tailscaleBin,
        ['--socket', this.socketPath, ...args],
        { timeout },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout || '');
        }
      );
    });
  }

  /**
   * Public exec — same as _runCli but guards the ready flag.
   */
  exec(args, timeout) {
    if (!this.ready) return Promise.reject(new Error('Tailscale runtime not ready'));
    return this._runCli(args, timeout);
  }

  /**
   * Spawn a long-running tailscale CLI command (e.g. `file cp`).
   * Returns the ChildProcess so the caller can observe stdout / close events.
   * @param {string[]} args
   * @param {number}   timeout — ms hard kill (default 5 min)
   */
  spawnCli(args, timeout = 300000) {
    const child = spawn(
      this.tailscaleBin,
      ['--socket', this.socketPath, ...args],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const t = setTimeout(() => child.kill(), timeout);
    child.on('close', () => clearTimeout(t));
    return child;
  }

  /**
   * Convenience: parse `tailscale status --json`.
   */
  async getStatus() {
    const stdout = await this.exec(['status', '--json']);
    return JSON.parse(stdout);
  }
}

module.exports = new TailscaleRuntime();
