/**
 * DropBeam Web Server
 * Run with: node server.js  (or npm run web)
 *
 * - HTTP on port 3000  → serves frontend
 * - WebSocket on port 47821 → signaling (same port Electron uses)
 * - REST GET /devices  → discovered peers list
 * - REST GET /info     → this server's identity
 * - mDNS + subnet-scan fallback for discovery
 */

'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { WebSocketServer, WebSocket } = require('ws');
const multicastDns = require('multicast-dns');

// ─── Config ───────────────────────────────────────────────────────────────────
const HTTP_PORT = parseInt(process.env.HTTP_PORT || process.env.PORT || 3000);
const SIGNAL_PORT = parseInt(process.env.SIGNAL_PORT || process.env.PORT || 47821);
const SERVICE_TYPE = '_dropbeam._tcp.local';

const deviceName = os.hostname() + ' (web)';
const deviceId = `${os.hostname()}-web-${Math.random().toString(36).slice(2, 7)}`;

// ─── State ────────────────────────────────────────────────────────────────────
const discoveredDevices = new Map(); // id -> { id, name, host, port, lastSeen }
const connectedBrowsers = new Map(); // peerId -> WebSocket
const pendingTransfers = new Map(); // recipientId -> [{ transferId, senderId, senderName, files, queuedAt }]
const transferIndex = new Map(); // transferId -> recipientId (for fast DELETE lookup)
const MAX_PENDING = 20;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getLocalIps() {
  const ips = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips.length ? ips : ['127.0.0.1'];
}

function getLocalIp() { return getLocalIps()[0]; }
function getDeviceList() { return Array.from(discoveredDevices.values()); }

function broadcastToBrowsers(msg, excludeId = null) {
  const str = typeof msg === 'string' ? msg : JSON.stringify(msg);
  for (const [id, ws] of connectedBrowsers) {
    if (id !== excludeId && ws.readyState === WebSocket.OPEN) ws.send(str);
  }
}

function addDevice(dev) {
  const existing = discoveredDevices.get(dev.id);
  discoveredDevices.set(dev.id, { ...dev, lastSeen: Date.now() });
  if (!existing) {
    broadcastToBrowsers({ type: 'devices-updated', devices: getDeviceList() });
    console.log(`[discovery] Found: ${dev.name} @ ${dev.host}:${dev.port}`);
  }
}

// ─── HTTP Server (port 3000) ──────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
};

function serveStatic(req, res) {
  let filePath;
  if (req.url === '/' || req.url === '/index.html') {
    filePath = path.join(__dirname, 'src', 'index.html');
  } else if (req.url === '/app.js') {
    filePath = path.join(__dirname, 'src', 'app.js');
  } else {
    filePath = path.join(__dirname, 'src', req.url.replace(/^\//, ''));
    if (!fs.existsSync(filePath)) {
      filePath = path.join(__dirname, req.url.replace(/^\//, ''));
    }
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404); res.end('Not found'); return;
  }

  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];

  if (url === '/devices' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getDeviceList())); return;
  }
  if (url === '/info' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: deviceId, name: deviceName, port: SIGNAL_PORT })); return;
  }

  // ─── Queue REST endpoints ────────────────────────────────────────────────────
  if (url === '/queue' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { recipientId, senderId, senderName, files } = JSON.parse(body);
        if (!recipientId || !senderId || !Array.isArray(files)) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'Missing fields' })); return;
        }
        // Count total pending across all recipients
        let totalPending = 0;
        for (const arr of pendingTransfers.values()) totalPending += arr.length;
        if (totalPending >= MAX_PENDING) {
          res.writeHead(429); res.end(JSON.stringify({ error: 'Queue full' })); return;
        }
        const transferId = `t-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
        const record = { transferId, senderId, senderName: senderName || senderId, files, queuedAt: Date.now() };
        if (!pendingTransfers.has(recipientId)) pendingTransfers.set(recipientId, []);
        pendingTransfers.get(recipientId).push(record);
        transferIndex.set(transferId, recipientId);
        console.log(`[queue] Queued ${transferId} for ${recipientId} from ${senderName}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ transferId }));
      } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Bad JSON' })); }
    });
    return;
  }

  if (url.startsWith('/queue/') && req.method === 'GET') {
    const peerId = url.slice(7);
    const transfers = pendingTransfers.get(peerId) || [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(transfers)); return;
  }

  if (url.startsWith('/queue/') && req.method === 'DELETE') {
    const transferId = url.slice(7);
    const recipientId = transferIndex.get(transferId);
    if (recipientId) {
      const arr = pendingTransfers.get(recipientId) || [];
      const filtered = arr.filter(t => t.transferId !== transferId);
      if (filtered.length === 0) pendingTransfers.delete(recipientId);
      else pendingTransfers.set(recipientId, filtered);
      transferIndex.delete(transferId);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true })); return;
  }

  serveStatic(req, res);
});

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[http] Port ${HTTP_PORT} already in use. Try a different port: HTTP_PORT=3001 node server.js`);
    process.exit(1);
  } else { throw err; }
});
httpServer.listen(process.env.HTTP_PORT || HTTP_PORT, '0.0.0.0', () => {
  const ips = getLocalIps();
  console.log('\n🚀 DropBeam Web Server started');
  console.log('─'.repeat(40));
  ips.forEach(ip => console.log(`   http://${ip}:${HTTP_PORT}`));
  console.log(`   (also http://localhost:${HTTP_PORT})`);
  console.log('─'.repeat(40));
  console.log(`📡 Signaling WS on port ${SIGNAL_PORT}`);
  console.log(`🔍 Discovering peers via mDNS + subnet scan\n`);
});

// ─── Signaling WebSocket Server (port 47821) ──────────────────────────────────
// Protocol:
//   Browser→Server: { action:'register' }
//   Browser→Server: { action:'forward', targetHost, targetPort, payload:{...} }
//   Server→Browser: { type:'self-info', id, name, ip, port }
//   Server→Browser: { type:'devices-updated', devices:[...] }
//   Server→Browser: { type:'signal', from, type, data, ... }
//   Peer→Server (direct): { from, type, data, ... }  → forwarded to browsers

// WS server shares the same HTTP server (single port for cloud deployment)
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const remoteIp = (req.socket.remoteAddress || '').replace('::ffff:', '');
  let peerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.action === 'register') {
      // Client sends { action:'register', id, name }
      peerId = msg.id || `peer-${Math.random().toString(36).slice(2, 7)}`;
      const peerName = msg.name || remoteIp;
      connectedBrowsers.set(peerId, ws);

      // Add to device list so others can see this peer
      addDevice({ id: peerId, name: peerName, host: 'signal', port: HTTP_PORT, relay: true });

      // Tell this client who they are + current device list
      ws.send(JSON.stringify({ type: 'self-info', id: peerId, name: peerName, ip: remoteIp, port: HTTP_PORT }));
      ws.send(JSON.stringify({ type: 'devices-updated', devices: getDeviceList().filter(d => d.id !== peerId) }));

      // Notify about any pending (queued) transfers
      const pending = pendingTransfers.get(peerId);
      if (pending && pending.length > 0) {
        ws.send(JSON.stringify({ type: 'pending-transfers', transfers: pending }));
      }

      // Tell everyone else about the new peer
      broadcastToBrowsers({ type: 'devices-updated', devices: getDeviceList() }, peerId);
      console.log(`[ws] ${peerName} (${peerId}) connected from ${remoteIp}`);
      return;
    }

    if (msg.action === 'notify-sender') {
      // Recipient is ready — tell the sender to start the transfer
      const senderWs = connectedBrowsers.get(msg.senderId);
      if (senderWs && senderWs.readyState === WebSocket.OPEN) {
        senderWs.send(JSON.stringify({ type: 'recipient-online', transferId: msg.transferId, recipientId: peerId }));
      }
      return;
    }

    if (msg.action === 'forward') {
      // Forward signal to a specific peer by id (relay mode for internet peers)
      const targetWs = connectedBrowsers.get(msg.targetId);
      if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify({ type: 'signal', from: peerId, payload: msg.payload }));
      } else {
        // Fall back to direct device forwarding (LAN)
        forwardSignalToDevice(msg.targetHost, msg.targetPort, msg.payload);
      }
      return;
    }

    // Inbound signal from another peer → forward to browser clients
    broadcastToBrowsers({ type: 'signal', from: peerId, ...msg });
  });

  ws.on('close', () => {
    if (peerId) {
      connectedBrowsers.delete(peerId);
      discoveredDevices.delete(peerId);
      broadcastToBrowsers({ type: 'devices-updated', devices: getDeviceList() });
      console.log(`[ws] ${peerId} disconnected`);
    }
  });
  ws.on('error', () => {
    if (peerId) connectedBrowsers.delete(peerId);
  });
});

// WS now attached to httpServer — no separate listen needed

function forwardSignalToDevice(host, port, payload) {
  let ws2;
  try { ws2 = new WebSocket(`ws://${host}:${port}`); } catch (e) { return; }
  ws2.on('open', () => { ws2.send(JSON.stringify(payload)); ws2.close(); });
  ws2.on('error', (e) => console.warn(`[forward] ${host}:${port} - ${e.message}`));
}

// ─── mDNS Discovery ───────────────────────────────────────────────────────────
function startMdns() {
  let mdns;
  try { mdns = multicastDns(); } catch (e) {
    console.warn('[mdns] Failed to start:', e.message); return;
  }

  mdns.on('query', (query) => {
    query.questions.forEach(q => {
      if (q.name === '_dropbeam._tcp.local' || q.name === SERVICE_TYPE) {
        const localIp = getLocalIp();
        mdns.respond({ answers: [
          { name: '_dropbeam._tcp.local', type: 'PTR', data: `${deviceId}._dropbeam._tcp.local` },
          { name: `${deviceId}._dropbeam._tcp.local`, type: 'SRV',
            data: { port: SIGNAL_PORT, weight: 0, priority: 0, target: `${deviceId}.local` } },
          { name: `${deviceId}._dropbeam._tcp.local`, type: 'TXT',
            data: [`id=${deviceId}`, `name=${deviceName}`, `port=${SIGNAL_PORT}`] },
          { name: `${deviceId}.local`, type: 'A', data: localIp }
        ]});
      }
    });
  });

  mdns.on('response', (response) => {
    let id = null, name = null, port = null, ip = null;
    response.answers.forEach(a => {
      if (a.type === 'TXT' && a.name.includes('_dropbeam')) {
        a.data.forEach(buf => {
          const str = buf.toString ? buf.toString() : String(buf);
          if (str.startsWith('id=')) id = str.slice(3);
          if (str.startsWith('name=')) name = str.slice(5);
          if (str.startsWith('port=')) port = parseInt(str.slice(5));
        });
      }
      if (a.type === 'A') ip = a.data;
    });
    if (id && id !== deviceId && ip && port) addDevice({ id, name: name || id, host: ip, port });
  });

  mdns.on('error', (e) => console.warn('[mdns] error:', e.message));

  const query = () => mdns.query({ questions: [{ name: '_dropbeam._tcp.local', type: 'PTR' }] });
  setTimeout(query, 1000);
  setInterval(query, 8000);

  setInterval(() => {
    const now = Date.now(); let changed = false;
    for (const [id, dev] of discoveredDevices) {
      if (now - dev.lastSeen > 20000) { discoveredDevices.delete(id); changed = true; }
    }
    if (changed) broadcastToBrowsers({ type: 'devices-updated', devices: getDeviceList() });
  }, 15000);

  console.log('[mdns] Discovery started');
}

// ─── Subnet Scan Fallback ─────────────────────────────────────────────────────
function startSubnetScan() {
  const localIp = getLocalIp();
  const parts = localIp.split('.');
  if (parts.length !== 4) return;
  const subnet = parts.slice(0, 3).join('.');
  console.log(`[scan] Subnet scan on ${subnet}.0/24 port ${SIGNAL_PORT}`);

  function scanHost(ip) {
    return new Promise((resolve) => {
      if (ip === localIp) { resolve(null); return; }
      const req = http.request(
        { hostname: ip, port: SIGNAL_PORT, path: '/info', method: 'GET', timeout: 600 },
        (res) => {
          let data = '';
          res.on('data', d => data += d);
          res.on('end', () => {
            try {
              const info = JSON.parse(data);
              if (info.id && info.id !== deviceId) {
                resolve({ id: info.id, name: info.name || info.id, host: ip, port: info.port || SIGNAL_PORT });
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
      results.forEach(r => { if (r) addDevice(r); });
      await new Promise(r => setTimeout(r, 50));
    }
    console.log('[scan] Complete');
  }

  setTimeout(runScan, 3000);
  setInterval(runScan, 60000);
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
startMdns();
startSubnetScan();
