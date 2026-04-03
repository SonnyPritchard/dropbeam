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

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

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
  setTimeout(() => { startMdns(); startSubnetScan(); }, 500);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (mdns) mdns.destroy();
  if (signalingServer) signalingServer.close();
  if (process.platform !== 'darwin') app.quit();
});
