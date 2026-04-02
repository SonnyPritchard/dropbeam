// ─── DropBeam Renderer (app.js) ───────────────────────────────────────────────
// Uses browser-native WebRTC + window.dropbeam IPC bridge

const db = window.dropbeam;

// ─── State ────────────────────────────────────────────────────────────────────
let selfInfo = null;
let devices = [];
let devicePeerConns = new Map(); // deviceId -> RTCPeerConnection
let deviceDataChannels = new Map(); // deviceId -> RTCDataChannel
let pendingTransfers = new Map(); // transferId -> { resolve, reject }
let incomingTransfers = new Map(); // transferId -> { chunks[], meta, received }
let pendingIncoming = null; // { transferId, meta, resolve, reject }
let dragTargetDevice = null;
let selectedFiles = [];

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  selfInfo = await db.getSelfInfo();
  document.getElementById('self-name').textContent = selfInfo.name;

  devices = await db.getDevices();
  renderDevices();

  db.onDevicesUpdated((updated) => {
    devices = updated;
    renderDevices();
  });

  db.onSignalReceived((signal) => handleSignal(signal));

  setupDropZone();
  setupRefresh();

  document.getElementById('clear-log').addEventListener('click', () => {
    document.getElementById('activity-log').innerHTML = '';
  });

  log('info', `DropBeam started as "${selfInfo.name}" (${selfInfo.ip}:${selfInfo.port})`);
}

// ─── Device rendering ─────────────────────────────────────────────────────────
function renderDevices() {
  const list = document.getElementById('device-list');
  if (devices.length === 0) {
    list.innerHTML = `
      <div class="no-devices">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2"/>
          <path d="M8 21h8M12 17v4"/>
        </svg>
        <div>No devices found yet…<br/>Make sure others have DropBeam open</div>
      </div>`;
    return;
  }

  list.innerHTML = '';
  devices.forEach(device => {
    const card = document.createElement('div');
    card.className = 'device-card';
    card.dataset.deviceId = device.id;
    card.innerHTML = `
      <div class="device-name">💻 ${escHtml(device.name)}</div>
      <div class="device-ip">${escHtml(device.host)}:${device.port}</div>
      <div class="device-status idle" id="status-${cssId(device.id)}">Ready to receive</div>
      <div class="device-progress" id="progress-${cssId(device.id)}">
        <div class="device-progress-fill" id="progress-fill-${cssId(device.id)}" style="width:0%"></div>
      </div>
    `;

    // Drag & drop on device card
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      card.classList.add('drag-over');
      dragTargetDevice = device;
    });
    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over');
    });
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      card.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) sendFilesToDevice(files, device);
    });

    list.appendChild(card);
  });
}

function setDeviceStatus(deviceId, text, type = 'idle') {
  const el = document.getElementById(`status-${cssId(deviceId)}`);
  if (el) { el.textContent = text; el.className = `device-status ${type}`; }
}

function setDeviceProgress(deviceId, pct) {
  const bar = document.getElementById(`progress-${cssId(deviceId)}`);
  const fill = document.getElementById(`progress-fill-${cssId(deviceId)}`);
  if (bar && fill) {
    if (pct >= 0 && pct <= 100) {
      bar.classList.add('active');
      fill.style.width = `${pct}%`;
    } else {
      bar.classList.remove('active');
      fill.style.width = '0%';
    }
  }
}

// ─── Drop zone (global drop target) ──────────────────────────────────────────
function setupDropZone() {
  const zone = document.getElementById('drop-zone');

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag-active');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-active'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-active');
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    if (devices.length === 0) {
      showToast('No devices found', 'Drop onto a device card in the sidebar', 'error');
      return;
    }
    if (devices.length === 1) {
      sendFilesToDevice(files, devices[0]);
    } else {
      showToast('Select a device', 'Drag files directly onto a device in the sidebar', 'warn');
    }
  });
}

function setupRefresh() {
  const btn = document.getElementById('refresh-btn');
  const icon = document.getElementById('refresh-icon');
  btn.addEventListener('click', async () => {
    icon.classList.add('spinning');
    devices = await db.getDevices();
    renderDevices();
    setTimeout(() => icon.classList.remove('spinning'), 800);
  });
}

// ─── Sending files ─────────────────────────────────────────────────────────────
async function sendFilesToDevice(files, device) {
  for (const file of files) {
    await sendOneFile(file, device);
  }
}

async function sendOneFile(file, device) {
  const transferId = generateId();
  log('info', `Sending "${file.name}" to ${device.name}…`);
  setDeviceStatus(device.id, `Sending ${file.name}…`, 'sending');
  setDeviceProgress(device.id, 0);

  try {
    // Read file
    const fileData = await readFileAsBase64(file);

    // Get or create WebRTC connection to device
    const { pc, dc } = await getOrCreateConnection(device, transferId);

    // Wait for data channel to open
    await waitForOpen(dc);

    // Send metadata first
    const meta = JSON.stringify({
      type: 'meta',
      transferId,
      fromName: selfInfo.name,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type
    });
    dc.send(meta);

    // Wait for accept/decline
    const accepted = await waitForAcceptance(transferId);
    if (!accepted) {
      log('warn', `${device.name} declined "${file.name}"`);
      setDeviceStatus(device.id, 'Declined', 'idle');
      setDeviceProgress(device.id, -1);
      showToast('Transfer declined', `${device.name} declined "${file.name}"`, 'warn');
      return;
    }

    // Send file in chunks
    const CHUNK_SIZE = 64 * 1024; // 64KB chunks
    const raw = base64ToUint8(fileData);
    const total = raw.length;
    let offset = 0;
    let chunkIndex = 0;

    while (offset < total) {
      const chunk = raw.slice(offset, offset + CHUNK_SIZE);
      const msg = JSON.stringify({
        type: 'chunk',
        transferId,
        index: chunkIndex,
        data: uint8ToBase64(chunk),
        final: offset + chunk.length >= total
      });
      dc.send(msg);
      offset += chunk.length;
      chunkIndex++;
      const pct = Math.round((offset / total) * 100);
      setDeviceProgress(device.id, pct);

      // Throttle slightly to avoid flooding the data channel
      if (chunkIndex % 16 === 0) await sleep(1);
    }

    setDeviceStatus(device.id, `✓ Sent ${file.name}`, 'done');
    setDeviceProgress(device.id, -1);
    log('success', `"${file.name}" sent to ${device.name}`);
    showToast('Transfer complete', `"${file.name}" sent to ${device.name}`, 'success');

    setTimeout(() => setDeviceStatus(device.id, 'Ready to receive', 'idle'), 3000);

  } catch (err) {
    console.error(err);
    setDeviceStatus(device.id, 'Error', 'idle');
    setDeviceProgress(device.id, -1);
    log('error', `Failed to send "${file.name}": ${err.message}`);
    showToast('Transfer failed', err.message, 'error');
  }
}

// ─── WebRTC Connection Management ─────────────────────────────────────────────
async function getOrCreateConnection(device, transferId) {
  // Always create a fresh connection per transfer for simplicity
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const dc = pc.createDataChannel('transfer', { ordered: true });
  dc.binaryType = 'arraybuffer';

  // ICE candidate exchange via signaling server
  pc.onicecandidate = async ({ candidate }) => {
    if (candidate) {
      await db.sendSignal({
        targetId: device.id,
        type: 'ice-candidate',
        data: { candidate, transferId }
      }).catch(() => {});
    }
  };

  // Store so we can add ICE candidates later
  devicePeerConns.set(transferId, pc);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Send offer via signaling
  await db.sendSignal({
    targetId: device.id,
    type: 'offer',
    data: { sdp: offer, transferId }
  });

  // Wait for answer
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timeout (no answer)')), 15000);
    pendingTransfers.set(`answer-${transferId}`, {
      resolve: (answer) => {
        clearTimeout(timeout);
        pc.setRemoteDescription(answer).then(resolve).catch(reject);
      },
      reject
    });
  });

  return { pc, dc };
}

// ─── Signal handling ──────────────────────────────────────────────────────────
async function handleSignal({ from, type, data }) {
  if (type === 'offer') {
    await handleOffer(from, data);
  } else if (type === 'answer') {
    const pending = pendingTransfers.get(`answer-${data.transferId}`);
    if (pending) {
      pendingTransfers.delete(`answer-${data.transferId}`);
      pending.resolve(data.sdp);
    }
  } else if (type === 'ice-candidate') {
    const pc = devicePeerConns.get(data.transferId);
    if (pc && data.candidate) {
      pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
    }
  } else if (type === 'transfer-accepted') {
    const pending = pendingTransfers.get(`accept-${data.transferId}`);
    if (pending) { pendingTransfers.delete(`accept-${data.transferId}`); pending.resolve(true); }
  } else if (type === 'transfer-declined') {
    const pending = pendingTransfers.get(`accept-${data.transferId}`);
    if (pending) { pendingTransfers.delete(`accept-${data.transferId}`); pending.resolve(false); }
  }
}

async function handleOffer(fromId, { sdp, transferId }) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  devicePeerConns.set(transferId, pc);

  pc.onicecandidate = async ({ candidate }) => {
    if (candidate) {
      await db.sendSignal({
        targetId: fromId,
        type: 'ice-candidate',
        data: { candidate, transferId }
      }).catch(() => {});
    }
  };

  pc.ondatachannel = ({ channel }) => {
    channel.binaryType = 'arraybuffer';
    setupReceiverChannel(channel, fromId, transferId);
  };

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  await db.sendSignal({
    targetId: fromId,
    type: 'answer',
    data: { sdp: answer, transferId }
  });
}

function setupReceiverChannel(channel, fromId, transferId) {
  let transferState = null;

  channel.onmessage = async ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'meta') {
      // Show accept/decline dialog
      transferState = {
        transferId: msg.transferId,
        fileName: msg.fileName,
        fileSize: msg.fileSize,
        fromName: msg.fromName,
        chunks: [],
        received: 0
      };
      incomingTransfers.set(msg.transferId, transferState);

      const accepted = await showIncomingModal(msg.fromName, msg.fileName, msg.fileSize);
      log(accepted ? 'info' : 'warn', accepted
        ? `Accepted "${msg.fileName}" from ${msg.fromName}`
        : `Declined "${msg.fileName}" from ${msg.fromName}`);

      await db.sendSignal({
        targetId: fromId,
        type: accepted ? 'transfer-accepted' : 'transfer-declined',
        data: { transferId: msg.transferId }
      });

      if (!accepted) {
        incomingTransfers.delete(msg.transferId);
      }

    } else if (msg.type === 'chunk') {
      const state = incomingTransfers.get(msg.transferId);
      if (!state) return;

      state.chunks[msg.index] = msg.data;
      state.received++;
      const pct = Math.round((state.received * 64 * 1024 / state.fileSize) * 100);

      if (msg.final) {
        // Save file
        try {
          const { filePath } = await db.saveFile({
            fileName: state.fileName,
            chunks: state.chunks
          });
          log('success', `Received "${state.fileName}" from ${state.fromName} → ${filePath}`);
          showToast('File received!', `"${state.fileName}" saved to Downloads`, 'success');
          incomingTransfers.delete(msg.transferId);
        } catch (err) {
          log('error', `Failed to save "${state.fileName}": ${err.message}`);
        }
      }
    }
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function waitForOpen(dc) {
  return new Promise((resolve, reject) => {
    if (dc.readyState === 'open') { resolve(); return; }
    const timeout = setTimeout(() => reject(new Error('Data channel open timeout')), 15000);
    dc.onopen = () => { clearTimeout(timeout); resolve(); };
    dc.onerror = (e) => { clearTimeout(timeout); reject(e); };
  });
}

function waitForAcceptance(transferId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingTransfers.delete(`accept-${transferId}`);
      reject(new Error('Acceptance timeout'));
    }, 30000);
    pendingTransfers.set(`accept-${transferId}`, {
      resolve: (v) => { clearTimeout(timeout); resolve(v); },
      reject: (e) => { clearTimeout(timeout); reject(e); }
    });
  });
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = reader.result.split(',')[1];
      resolve(b64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function base64ToUint8(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function uint8ToBase64(arr) {
  let bin = '';
  arr.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin);
}

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function cssId(str) {
  return str.replace(/[^a-z0-9]/gi, '_');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

// ─── Toast notifications ──────────────────────────────────────────────────────
function showToast(title, desc, type = 'info') {
  const icons = { success: '✅', error: '❌', warn: '⚠️', info: 'ℹ️' };
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <div class="toast-icon">${icons[type] || 'ℹ️'}</div>
    <div class="toast-body">
      <div class="toast-title">${escHtml(title)}</div>
      <div class="toast-desc">${escHtml(desc)}</div>
    </div>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ─── Activity log ─────────────────────────────────────────────────────────────
function log(type, msg) {
  const logEl = document.getElementById('activity-log');
  const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.innerHTML = `<span class="log-time">${now}</span><span class="log-msg">${escHtml(msg)}</span>`;
  logEl.prepend(entry);
  // Keep last 100 entries
  while (logEl.children.length > 100) logEl.removeChild(logEl.lastChild);
}

// ─── Incoming transfer modal ──────────────────────────────────────────────────
function showIncomingModal(fromName, fileName, fileSize) {
  return new Promise((resolve) => {
    document.getElementById('modal-desc').textContent = `${fromName} wants to send you a file`;
    document.getElementById('modal-file-name').textContent = fileName;
    document.getElementById('modal-file-size').textContent = formatBytes(fileSize);

    const overlay = document.getElementById('modal-overlay');
    overlay.classList.add('active');

    const acceptBtn = document.getElementById('modal-accept');
    const declineBtn = document.getElementById('modal-decline');

    const cleanup = () => overlay.classList.remove('active');

    acceptBtn.onclick = () => { cleanup(); resolve(true); };
    declineBtn.onclick = () => { cleanup(); resolve(false); };
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────
init().catch(console.error);
