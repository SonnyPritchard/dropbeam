const { autoUpdater } = require('electron-updater');
const { app, BrowserWindow, ipcMain, dialog, Notification, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const express = require('express');
const multicastDns = require('multicast-dns');

// ─── Config ───────────────────────────────────────────────────────────────────
const SERVICE_TYPE = '_dropbeam._tcp.local';
const SIGNAL_PORT_BASE = 47821;
let signalingPort = SIGNAL_PORT_BASE;

const deviceName = os.hostname();
const deviceId = `${deviceName}-${Math.random().toString(36).slice(2, 7)}`;

// ─── State ────────────────────────────────────────────────────────────────────
let mainWindow = null;
let mdns = null;
let signalingServer = null;
let peers = new Map();       // peerId -> { ws, peer, meta }
let discoveredDevices = new Map(); // peerId -> { name, host, port, lastSeen }
let pendingTransfers = new Map();  // transferId -> { resolve, reject }
let incomingTransfers = new Map(); // transferId -> { chunks, meta }

// ─── Simple-peer (pure-JS WebRTC via wrtc or browser) ─────────────────────────
// We use a manual WebRTC approach via the browser window's WebRTC + IPC bridge
// Main process handles: mDNS, signaling server, file I/O
// Renderer handles: WebRTC peer connections (has native WebRTC API)

// ─── Signaling Server ─────────────────────────────────────────────────────────
function startSignalingServer() {
  const expressApp = express();
  expressApp.use(express.json({ limit: '50mb' }));

  const server = http.createServer(expressApp);
  const wss = new WebSocketServer({ server });

  // REST endpoint: receive signal messages from remote peers
  expressApp.post('/signal', (req, res) => {
    const { from, type, data, transferMeta } = req.body;
    res.json({ ok: true });

    // Forward to renderer for WebRTC handling
    if (mainWindow) {
      mainWindow.webContents.send('signal-received', { from, type, data, transferMeta });
    }
  });

  // REST endpoint: info about this device
  expressApp.get('/info', (req, res) => {
    res.json({ id: deviceId, name: deviceName, port: signalingPort });
  });

  wss.on('connection', (ws) => {
    ws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);
        if (mainWindow) {
          mainWindow.webContents.send('signal-received', data);
        }
      } catch (e) {}
    });
  });

  server.listen(signalingPort, '0.0.0.0', () => {
    console.log(`Signaling server on port ${signalingPort}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      signalingPort++;
      server.listen(signalingPort, '0.0.0.0');
    }
  });

  signalingServer = server;
  return server;
}

// ─── mDNS Discovery ───────────────────────────────────────────────────────────
function startMdns() {
  mdns = multicastDns();

  // Announce ourselves
  const announceInterval = setInterval(() => {
    mdns.query({
      questions: [{ name: '_dropbeam._tcp.local', type: 'PTR' }]
    });
  }, 5000);

  mdns.on('query', (query) => {
    query.questions.forEach(q => {
      if (q.name === '_dropbeam._tcp.local' || q.name === SERVICE_TYPE) {
        // Respond with our service info
        const localIp = getLocalIp();
        mdns.respond({
          answers: [
            {
              name: '_dropbeam._tcp.local',
              type: 'PTR',
              data: `${deviceId}._dropbeam._tcp.local`
            },
            {
              name: `${deviceId}._dropbeam._tcp.local`,
              type: 'SRV',
              data: { port: signalingPort, weight: 0, priority: 0, target: `${deviceId}.local` }
            },
            {
              name: `${deviceId}._dropbeam._tcp.local`,
              type: 'TXT',
              data: [`id=${deviceId}`, `name=${deviceName}`, `port=${signalingPort}`]
            },
            {
              name: `${deviceId}.local`,
              type: 'A',
              data: localIp
            }
          ]
        });
      }
    });
  });

  mdns.on('response', (response) => {
    let id = null, name = null, port = null, ip = null;

    response.answers.forEach(a => {
      if (a.type === 'TXT' && a.name.includes('_dropbeam')) {
        a.data.forEach(buf => {
          const str = buf.toString ? buf.toString() : buf;
          if (str.startsWith('id=')) id = str.slice(3);
          if (str.startsWith('name=')) name = str.slice(5);
          if (str.startsWith('port=')) port = parseInt(str.slice(5));
        });
      }
      if (a.type === 'A') ip = a.data;
    });

    if (id && id !== deviceId && ip && port) {
      const existing = discoveredDevices.get(id);
      discoveredDevices.set(id, { id, name: name || id, host: ip, port, lastSeen: Date.now() });
      if (!existing && mainWindow) {
        mainWindow.webContents.send('devices-updated', getDeviceList());
      }
    }
  });

  // Prune stale devices every 15s
  setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [id, dev] of discoveredDevices) {
      if (now - dev.lastSeen > 15000) {
        discoveredDevices.delete(id);
        changed = true;
      }
    }
    if (changed && mainWindow) {
      mainWindow.webContents.send('devices-updated', getDeviceList());
    }
  }, 15000);

  // Initial query
  setTimeout(() => {
    mdns.query({ questions: [{ name: '_dropbeam._tcp.local', type: 'PTR' }] });
  }, 1000);
}

function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function getDeviceList() {
  return Array.from(discoveredDevices.values());
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────
ipcMain.handle('get-self-info', () => ({
  id: deviceId,
  name: deviceName,
  ip: getLocalIp(),
  port: signalingPort
}));

ipcMain.handle('get-devices', () => getDeviceList());

// Send signal to a remote peer via WebSocket (compatible with Electron + web server)
ipcMain.handle('send-signal', async (event, { targetId, type, data, transferMeta }) => {
  const target = discoveredDevices.get(targetId);
  if (!target) throw new Error(`Device ${targetId} not found`);

  const payload = JSON.stringify({ from: deviceId, fromName: deviceName, type, data, transferMeta });
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(`ws://${target.host}:${target.port}`); }
    catch (e) { reject(e); return; }
    const timeout = setTimeout(() => { ws.terminate(); reject(new Error('Signal timeout')); }, 5000);
    ws.on('open', () => { ws.send(payload); clearTimeout(timeout); ws.close(); resolve({ ok: true }); });
    ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });
});

// Show accept/decline dialog for incoming transfer
ipcMain.handle('show-transfer-dialog', async (event, { fromName, fileName, fileSize }) => {
  if (!mainWindow) return false;
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Accept', 'Decline'],
    defaultId: 0,
    cancelId: 1,
    title: 'Incoming Transfer',
    message: `${fromName} wants to send you a file`,
    detail: `${fileName} (${formatBytes(fileSize)})`
  });
  return result.response === 0;
});

// Save received file chunks
ipcMain.handle('save-file', async (event, { fileName, chunks }) => {
  const downloadsDir = app.getPath('downloads');
  let filePath = path.join(downloadsDir, fileName);

  // Avoid overwriting
  let counter = 1;
  while (fs.existsSync(filePath)) {
    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext);
    filePath = path.join(downloadsDir, `${base} (${counter})${ext}`);
    counter++;
  }

  // chunks is array of base64 strings
  const buffers = chunks.map(c => Buffer.from(c, 'base64'));
  const total = Buffer.concat(buffers);
  fs.writeFileSync(filePath, total);

  // Notify
  if (Notification.isSupported()) {
    new Notification({
      title: 'DropBeam',
      body: `Received: ${fileName}`
    }).show();
  }

  shell.showItemInFolder(filePath);
  return { filePath };
});

// Read file for sending
ipcMain.handle('read-file', async (event, { filePath }) => {
  const stat = fs.statSync(filePath);
  const data = fs.readFileSync(filePath);
  return {
    name: path.basename(filePath),
    size: stat.size,
    data: data.toString('base64')
  };
});

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}


// ─── Subnet Scan Fallback Discovery ─────────────────────────────────────────
function startSubnetScan() {
  const localIp = getLocalIp();
  const parts = localIp.split('.');
  if (parts.length !== 4) return;
  const subnet = parts.slice(0, 3).join('.');
  console.log(`[scan] Subnet scan on ${subnet}.0/24 port ${signalingPort}`);

  function scanHost(ip) {
    return new Promise((resolve) => {
      if (ip === localIp) { resolve(null); return; }
      const req = http.request(
        { hostname: ip, port: signalingPort, path: '/info', method: 'GET', timeout: 600 },
        (res) => {
          let data = '';
          res.on('data', d => data += d);
          res.on('end', () => {
            try {
              const info = JSON.parse(data);
              if (info.id && info.id !== deviceId) {
                resolve({ id: info.id, name: info.name || info.id, host: ip, port: info.port || signalingPort });
              } else { resolve(null); }
            } catch { resolve(null); }
          });
        }
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    });
  }

  async function runScan() {
    const BATCH = 20;
    for (let start = 1; start <= 254; start += BATCH) {
      const batch = [];
      for (let i = start; i < start + BATCH && i <= 254; i++) batch.push(scanHost(`${subnet}.${i}`));
      const results = await Promise.all(batch);
      results.forEach(r => {
        if (!r) return;
        const existing = discoveredDevices.get(r.id);
        discoveredDevices.set(r.id, { ...r, lastSeen: Date.now() });
        if (!existing && mainWindow) {
          mainWindow.webContents.send('devices-updated', getDeviceList());
          console.log(`[scan] Found: ${r.name} @ ${r.host}:${r.port}`);
        }
      });
      await new Promise(res => setTimeout(res, 50));
    }
    console.log('[scan] Complete');
  }

  setTimeout(runScan, 3000);
  setInterval(runScan, 60000);
}


// ─── Tailscale Integration ────────────────────────────────────────────────────
const { exec: cpExec } = require('child_process');
const https = require('https');

async function getTailscalePeers() {
  return new Promise((resolve) => {
    cpExec('tailscale status --json', { timeout: 5000 }, (err, stdout) => {
      if (err) {
        // Check if tailscale simply isn't installed vs. other error
        if (err.code === 127 || err.message?.includes('not found') || err.message?.includes('ENOENT')) {
          return resolve({ available: false, reason: 'not-installed' });
        }
        return resolve({ available: false, reason: err.message });
      }
      try {
        const status = JSON.parse(stdout);
        const peers = Object.values(status.Peer || {}).map(p => ({
          name: (p.HostName || p.DNSName || '').replace(/\.$/, ''),
          ip: (p.TailscaleIPs || [])[0] || null,
          os: p.OS || 'unknown',
          online: p.Online === true
        })).filter(p => p.ip);
        resolve({ available: true, self: status.Self?.HostName || os.hostname(), peers });
      } catch (parseErr) {
        resolve({ available: false, reason: 'parse-error' });
      }
    });
  });
}

ipcMain.handle('tailscale:getPeers', () => getTailscalePeers());

ipcMain.handle('tailscale:sendFile', async (event, { filePath, peerIp }) => {
  return new Promise((resolve, reject) => {
    if (!filePath || !peerIp) return reject(new Error('filePath and peerIp required'));

    // tailscale file cp <file> <ip>:
    const child = cpExec(
      `tailscale file cp "${filePath.replace(/"/g, '\\"')}" "${peerIp}:"`,
      { timeout: 300000 },
      (err) => {
        if (err) reject(new Error(err.message));
        else resolve({ ok: true });
      }
    );

    // Tailscale file cp doesn't emit progress — show indeterminate via fake ticks
    let pct = 0;
    const tick = setInterval(() => {
      pct = Math.min(pct + 5, 90);
      if (mainWindow) mainWindow.webContents.send('tailscale:progress', pct);
    }, 500);

    child.on('close', () => {
      clearInterval(tick);
      if (mainWindow) mainWindow.webContents.send('tailscale:progress', 100);
    });
  });
});

// ─── Internet (Render) Integration ───────────────────────────────────────────
const RENDER_API = 'https://dropbeam.onrender.com';
let renderWs = null;
let renderWsReady = false;
const renderPendingMessages = [];

function connectToPublicSignal() {
  if (renderWs) return; // already connecting/connected

  try {
    renderWs = new WebSocket('wss://dropbeam.onrender.com');
  } catch (e) {
    console.warn('[internet] WebSocket init failed:', e.message);
    return;
  }

  renderWs.on('open', () => {
    renderWsReady = true;
    console.log('[internet] Connected to Render signal server');
    // Register
    renderWs.send(JSON.stringify({ action: 'register', id: deviceId, name: deviceName }));
    // Flush pending
    renderPendingMessages.forEach(m => renderWs.send(m));
    renderPendingMessages.length = 0;
    // Keepalive
    const ping = setInterval(() => {
      if (renderWs && renderWs.readyState === WebSocket.OPEN) {
        renderWs.send(JSON.stringify({ action: 'ping' }));
      } else {
        clearInterval(ping);
      }
    }, 30000);
  });

  renderWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      // Forward signals to renderer — same handling as local signals
      if (msg.type === 'signal' || msg.type === 'offer' || msg.type === 'answer' || msg.type === 'ice-candidate') {
        if (mainWindow) mainWindow.webContents.send('signal-received', msg.payload || msg);
        return;
      }
      if (msg.type === 'devices-updated') {
        if (mainWindow) mainWindow.webContents.send('internet-devices-updated', msg.devices || []);
        return;
      }
      // Generic passthrough to renderer
      if (mainWindow) mainWindow.webContents.send('render-ws-message', msg);
    } catch (e) {}
  });

  renderWs.on('close', () => {
    renderWsReady = false;
    renderWs = null;
    console.log('[internet] Render WS closed — reconnecting in 5s');
    setTimeout(connectToPublicSignal, 5000);
  });

  renderWs.on('error', (e) => {
    console.warn('[internet] Render WS error:', e.message);
    // close event will fire and trigger reconnect
  });
}

ipcMain.handle('internet:getDevices', async () => {
  return new Promise((resolve) => {
    https.get(`${RENDER_API}/devices`, { timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
});

// Forward a signal via Render WS (for internet peers)
ipcMain.handle('internet:sendSignal', async (event, payload) => {
  const msg = JSON.stringify(payload);
  if (renderWsReady && renderWs?.readyState === WebSocket.OPEN) {
    renderWs.send(msg);
  } else {
    renderPendingMessages.push(msg);
  }
  return { ok: true };
});


// ─── App Lifecycle ─────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 650,
    minWidth: 700,
    minHeight: 500,
    backgroundColor: '#0f0f13',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    show: false,
    icon: path.join(__dirname, '../assets/icon.png')
  });

  // Auth check: verify stored JWT, load login or main app
  const auth = readAuthFile();
  if (auth && auth.token) {
    verifyToken(auth.token).then(user => {
      if (user) {
        mainWindow.loadFile(path.join(__dirname, 'index.html'));
        startDropbeamConnect(auth.token).catch(console.error);
      } else {
        deleteAuthFile();
        mainWindow.loadFile(path.join(__dirname, 'login.html'));
      }
    }).catch(() => {
      mainWindow.loadFile(path.join(__dirname, 'index.html'));
    });
  } else {
    mainWindow.loadFile(path.join(__dirname, 'login.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}


// ─── Auto-Update ──────────────────────────────────────────────────────────────
function setupAutoUpdater(win) {
  try {
    autoUpdater.setFeedURL({ provider: 'github', owner: 'SonnyPritchard', repo: 'dropbeam' });

    autoUpdater.on('update-available', () => {
      console.log('[updater] Update available — downloading...');
      if (win) win.webContents.send('update-available');
    });

    autoUpdater.on('update-downloaded', () => {
      console.log('[updater] Update downloaded — ready to install');
      if (win) win.webContents.send('update-ready');
    });

    autoUpdater.on('error', (err) => {
      console.warn('[updater] Error:', err.message);
    });

    autoUpdater.checkForUpdatesAndNotify();
  } catch (err) {
    console.warn('[updater] Auto-update setup failed:', err.message);
  }
}

ipcMain.on('restart-and-install', () => {
  try { autoUpdater.quitAndInstall(); } catch (e) { console.warn('[updater] quitAndInstall failed:', e.message); }
});

app.whenReady().then(() => {
  startSignalingServer();
  createWindow();

  // Auto-update check
  setupAutoUpdater(mainWindow);

  // Start mDNS + subnet scan after a short delay (so port is bound)
  setTimeout(() => { startMdns(); startSubnetScan(); connectToPublicSignal(); }, 500);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (connectStarted) {
    try { require('child_process').execSync('tailscale down', { timeout: 3000 }); } catch {}
  }
});

app.on('window-all-closed', () => {
  if (mdns) mdns.destroy();
  if (signalingServer) signalingServer.close();
  if (renderWs) { try { renderWs.terminate(); } catch(e) {} }
  if (process.platform !== 'darwin') app.quit();
});


// ─── DropBeam Connect — Auth & WireGuard ──────────────────────────────────────
const DROPBEAM_SERVER = process.env.DROPBEAM_SERVER || 'http://localhost:3001';
const AUTH_FILE = path.join(os.homedir(), '.dropbeam', 'auth.json');

let connectStarted = false; // track if we started tailscale

function ensureDropbeamDir() {
  const dir = path.join(os.homedir(), '.dropbeam');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readAuthFile() {
  try {
    ensureDropbeamDir();
    if (!fs.existsSync(AUTH_FILE)) return null;
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch { return null; }
}

function writeAuthFile(data) {
  ensureDropbeamDir();
  fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function deleteAuthFile() {
  try { if (fs.existsSync(AUTH_FILE)) fs.unlinkSync(AUTH_FILE); } catch {}
}

// HTTP helper (no node-fetch needed — use built-in http/https)
function httpRequest(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? require('https') : require('http');
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 8000
    };
    const req = mod.request(reqOpts, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function verifyToken(token) {
  try {
    const res = await httpRequest(`${DROPBEAM_SERVER}/auth/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    if (res.status === 200) return res.body;
    return null;
  } catch { return null; }
}

async function registerDevice(token) {
  try {
    const res = await httpRequest(`${DROPBEAM_SERVER}/devices/register`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    }, {});
    if (res.status === 200 || res.status === 201) return res.body;
    return null;
  } catch { return null; }
}

function emitConnectStatus(status) {
  // status: 'connecting' | 'connected' | 'not-connected' | 'not-installed'
  if (mainWindow) mainWindow.webContents.send('tailscale:connectStatus', status);
}

async function startDropbeamConnect(token) {
  emitConnectStatus('connecting');
  const deviceInfo = await registerDevice(token);
  if (!deviceInfo || !deviceInfo.preAuthKey) {
    console.warn('[connect] Device registration failed or no preAuthKey');
    emitConnectStatus('not-connected');
    return;
  }
  const { preAuthKey, headscaleUrl } = deviceInfo;
  const hostname = `dropbeam-${os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
  const cmd = `tailscale up --login-server "${headscaleUrl}" --auth-key "${preAuthKey}" --hostname "${hostname}"`;

  cpExec(cmd, { timeout: 30000 }, (err) => {
    if (err) {
      if (err.code === 127 || (err.message && (err.message.includes('not found') || err.message.includes('ENOENT')))) {
        console.warn('[connect] Tailscale not installed');
        emitConnectStatus('not-installed');
        if (Notification.isSupported()) {
          const n = new Notification({
            title: 'DropBeam Connect',
            body: 'Tailscale not found. Install it at tailscale.com/download to enable mesh networking.'
          });
          n.on('click', () => shell.openExternal('https://tailscale.com/download'));
          n.show();
        }
      } else {
        console.warn('[connect] tailscale up error:', err.message);
        emitConnectStatus('not-connected');
      }
      return;
    }
    connectStarted = true;
    console.log('[connect] Tailscale up — DropBeam Connect active');
    emitConnectStatus('connected');
  });
}

// ─── IPC: Auth handlers ────────────────────────────────────────────────────────
ipcMain.handle('auth:saveToken', async (event, { token, user }) => {
  writeAuthFile({ token, user });
  // Kick off device registration + tailscale in background
  startDropbeamConnect(token).catch(console.error);
  return { ok: true };
});

ipcMain.handle('auth:clearToken', () => { deleteAuthFile(); return { ok: true }; });

ipcMain.handle('auth:getUser', () => {
  const auth = readAuthFile();
  return auth ? auth.user : null;
});

ipcMain.handle('auth:loadApp', () => {
  if (mainWindow) mainWindow.loadFile(path.join(__dirname, 'index.html'));
  return { ok: true };
});

ipcMain.on('auth:getServerUrl', (event) => {
  event.returnValue = DROPBEAM_SERVER;
});

ipcMain.handle('auth:logout', async () => {
  deleteAuthFile();
  if (connectStarted) {
    cpExec('tailscale down', { timeout: 5000 }, () => {});
    connectStarted = false;
  }
  if (mainWindow) mainWindow.loadFile(path.join(__dirname, 'login.html'));
  return { ok: true };
});
