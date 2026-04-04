// ─── DropBeam Renderer (app.js) ───────────────────────────────────────────────
// Works in both Electron (via window.dropbeam preload IPC) and plain browser
// (via WebSocket + fetch to the local DropBeam web server)

const APP_VERSION = 'v1.1.2';

const db = window.dropbeam || createWebAdapter();

/**
 * Web adapter — mirrors the window.dropbeam API using WebSocket + fetch.
 */
function createWebAdapter() {
  const PUBLIC_SIGNAL = 'wss://dropbeam.onrender.com';
  const isLocal = location.hostname === 'localhost' || location.hostname.match(/^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./);
  const wsUrl = isLocal ? `ws://${location.hostname}:${location.port || 47821}` : PUBLIC_SIGNAL;

  let ws = null;
  let selfInfo = null;
  let devicesCallback = null;
  let signalCallback = null;
  let pendingFromServerCallback = null;
  let recipientOnlineCallback = null;
  let reconnectTimer = null;
  let wsReady = false;
  const pendingMessages = [];

  function connect() {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      wsReady = true;
      const localId = localStorage.getItem('dropbeam-id') || `peer-${Math.random().toString(36).slice(2,9)}`;
      localStorage.setItem('dropbeam-id', localId);
      const localName = localStorage.getItem('dropbeam-name') || navigator.platform || 'Browser';
      ws.send(JSON.stringify({ action: 'register', id: localId, name: localName }));
      pendingMessages.forEach(m => ws.send(m));
      pendingMessages.length = 0;
      const ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: 'ping' }));
        else clearInterval(ping);
      }, 30000);
    };
    ws.onmessage = ({ data }) => {
      let msg; try { msg = JSON.parse(data); } catch { return; }
      if (msg.type === 'self-info') { selfInfo = { id: msg.id, name: msg.name, ip: msg.ip, port: msg.port }; return; }
      if (msg.type === 'devices-updated') { if (devicesCallback) devicesCallback(msg.devices || []); return; }
      if (msg.type === 'signal') { if (signalCallback) signalCallback({ ...msg.payload, from: msg.from }); return; }
      if (msg.type === 'pending-transfers') { if (pendingFromServerCallback) pendingFromServerCallback(msg.transfers || []); return; }
      if (msg.type === 'recipient-online') { if (recipientOnlineCallback) recipientOnlineCallback(msg); return; }
    };
    ws.onclose = () => { wsReady = false; clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 3000); };
    ws.onerror = () => { ws.close(); };
  }

  connect();

  function wsSend(msg) {
    const str = JSON.stringify(msg);
    if (wsReady && ws.readyState === WebSocket.OPEN) ws.send(str);
    else pendingMessages.push(str);
  }

  return {
    getSelfInfo: async () => {
      for (let i = 0; i < 30 && !selfInfo; i++) await new Promise(r => setTimeout(r, 200));
      return selfInfo || { id: 'unknown', name: location.hostname, ip: location.hostname, port: 47821 };
    },
    getDevices: async () => {
      const base = isLocal ? `http://${location.host}` : 'https://dropbeam.onrender.com';
      const res = await fetch(`${base}/devices`).catch(() => null);
      if (res && res.ok) return (await res.json()).filter(d => d.id !== localStorage.getItem('dropbeam-id'));
      return [];
    },
    sendSignal: async ({ targetId, type, data, transferMeta }) => {
      wsSend({ action: 'forward', targetId, payload: { from: selfInfo?.id || 'browser', fromName: selfInfo?.name || 'Browser', type, data, transferMeta } });
      return { ok: true };
    },
    showTransferDialog: async ({ fromName, fileName, fileSize }) => true,
    saveFile: async ({ fileName, blob }) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fileName; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return { filePath: fileName };
    },
    readFile: async ({ filePath }) => { throw new Error('readFile not available in browser — use file picker'); },
    onDevicesUpdated: (cb) => { devicesCallback = cb; },
    onSignalReceived: (cb) => { signalCallback = cb; },
    onPendingTransfers: (cb) => { pendingFromServerCallback = cb; },
    onRecipientOnline: (cb) => { recipientOnlineCallback = cb; },
    sendWs: (msg) => wsSend(msg),
    getApiBase: () => isLocal ? `http://${location.host}` : 'https://dropbeam.onrender.com',
    removeAllListeners: () => {}
  };
}

// ─── State ────────────────────────────────────────────────────────────────────
let selfInfo = null;
let devices = [];
let devicePeerConns = new Map();
let deviceDataChannels = new Map();
let pendingTransfers = new Map();
let incomingTransfers = new Map();
let pendingIncoming = null;
let dragTargetDevice = null;

// Mobile state
let mobileSelectedFiles = [];
let mobileSendResolve = null; // resolves when user picks a device in the sheet

// Offline queuing state
let serverPendingTransfers = [];
let queuedTransfers = new Map();

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'turn:open.relay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:open.relay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:open.relay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
];

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  selfInfo = await db.getSelfInfo();
  const selfNameEl = document.getElementById('self-name');
  selfNameEl.textContent = selfInfo.name;
  selfNameEl.title = 'Tap to rename';
  selfNameEl.style.cursor = 'pointer';
  selfNameEl.addEventListener('click', () => {
    const newName = prompt('Enter device name:', selfInfo.name);
    if (newName && newName.trim()) {
      localStorage.setItem('dropbeam-name', newName.trim());
      selfNameEl.textContent = newName.trim();
      showToast('Name updated', 'Reload to reconnect with new name', 'info');
    }
  });

  devices = await db.getDevices();
  renderDevices();

  db.onDevicesUpdated((updated) => { devices = updated; renderDevices(); });
  db.onSignalReceived((signal) => handleSignal(signal));
  db.onPendingTransfers((transfers) => { serverPendingTransfers = transfers; if (transfers.length > 0) showPendingBanner(transfers); });
  db.onRecipientOnline(({ transferId, recipientId }) => {
    const queued = queuedTransfers.get(transferId);
    if (!queued) return;
    queuedTransfers.delete(transferId);
    log('info', `Recipient ${queued.contact.name} is online — starting transfer…`);
    const device = devices.find(d => d.id === recipientId) || { id: recipientId, name: queued.contact.name, host: 'signal', port: 0, relay: true };
    sendFilesToDevice(queued.files, device);
    renderContacts();
  });

  setupDropZone();
  setupMobileSend();
  setupRefresh();
  setupContacts();
  setupPendingModal();
  setupActivityToggle();

  document.getElementById('clear-log').addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('activity-log').innerHTML = '';
  });

  log('info', `DropBeam started as "${selfInfo.name}" (${selfInfo.ip}:${selfInfo.port})`);
}

// ─── Activity log toggle (collapsible on mobile) ──────────────────────────────
function setupActivityToggle() {
  const panel = document.getElementById('activity-panel');
  const header = document.getElementById('activity-header');
  header.addEventListener('click', (e) => {
    if (e.target.id === 'clear-log') return;
    panel.classList.toggle('collapsed');
  });
}

// ─── Device rendering ─────────────────────────────────────────────────────────
function renderDevices() {
  renderContacts();
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
      <div class="device-tap-hint">👆 Tap to send files</div>
      <div class="device-progress" id="progress-${cssId(device.id)}">
        <div class="device-progress-fill" id="progress-fill-${cssId(device.id)}" style="width:0%"></div>
      </div>
    `;

    // Desktop: drag & drop
    card.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); card.classList.add('drag-over'); dragTargetDevice = device; });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation(); card.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) sendFilesToDevice(files, device);
    });

    // Mobile: tap to send (resolves pending mobile device picker)
    card.addEventListener('click', () => {
      if (isMobile()) {
        if (mobileSelectedFiles.length > 0) {
          // files already chosen — send to this device
          sendFilesToDevice([...mobileSelectedFiles], device);
          clearMobileSelection();
        } else {
          // no files — trigger file picker first
          triggerMobileFilePicker(device);
        }
      }
    });

    list.appendChild(card);
  });

  // If mobile sheet is open and resolves are waiting, refresh it too
  if (document.getElementById('mobile-device-sheet').classList.contains('active')) {
    populateMobileSheet();
  }
}

function isMobile() {
  return window.matchMedia('(max-width: 768px)').matches;
}

function setDeviceStatus(deviceId, text, type = 'idle') {
  const el = document.getElementById(`status-${cssId(deviceId)}`);
  if (el) { el.textContent = text; el.className = `device-status ${type}`; }
}

function setDeviceProgress(deviceId, pct) {
  const bar = document.getElementById(`progress-${cssId(deviceId)}`);
  const fill = document.getElementById(`progress-fill-${cssId(deviceId)}`);
  if (bar && fill) {
    if (pct >= 0 && pct <= 100) { bar.classList.add('active'); fill.style.width = `${pct}%`; }
    else { bar.classList.remove('active'); fill.style.width = '0%'; }
  }
}

// ─── Mobile send flow ─────────────────────────────────────────────────────────
function setupMobileSend() {
  const chooseBtn = document.getElementById('mobile-choose-btn');
  const fileInput = document.getElementById('mobile-file-input');
  const sendNowBtn = document.getElementById('mobile-send-now-btn');
  const clearBtn = document.getElementById('mobile-clear-files-btn');
  const sheetCancel = document.getElementById('mobile-sheet-cancel');

  chooseBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files);
    if (files.length === 0) return;
    mobileSelectedFiles = files;
    renderMobileFileList(files);
    fileInput.value = ''; // reset so same file can be re-selected
  });

  sendNowBtn.addEventListener('click', () => {
    if (mobileSelectedFiles.length === 0) return;
    if (devices.length === 0) {
      showToast('No devices found', 'Make sure other devices have DropBeam open', 'error');
      return;
    }
    if (devices.length === 1) {
      sendFilesToDevice([...mobileSelectedFiles], devices[0]);
      clearMobileSelection();
    } else {
      showMobileDeviceSheet();
    }
  });

  clearBtn.addEventListener('click', () => clearMobileSelection());

  sheetCancel.addEventListener('click', () => {
    document.getElementById('mobile-device-sheet').classList.remove('active');
    if (mobileSendResolve) { mobileSendResolve(null); mobileSendResolve = null; }
  });
}

function triggerMobileFilePicker(device) {
  const fileInput = document.getElementById('mobile-file-input');
  // Temporarily listen once, then send to the specific device
  const onceHandler = () => {
    const files = Array.from(fileInput.files);
    fileInput.removeEventListener('change', onceHandler);
    if (files.length === 0) return;
    sendFilesToDevice(files, device);
    fileInput.value = '';
  };
  fileInput.addEventListener('change', onceHandler);
  fileInput.click();
}

function renderMobileFileList(files) {
  const listEl = document.getElementById('mobile-file-list');
  listEl.innerHTML = '';
  files.forEach(f => {
    const item = document.createElement('div');
    item.className = 'mobile-file-item';
    item.innerHTML = `<span class="mobile-file-name">${escHtml(f.name)}</span><span class="mobile-file-size">${formatBytes(f.size)}</span>`;
    listEl.appendChild(item);
  });
  document.getElementById('mobile-choose-btn').style.display = 'none';
  const container = document.getElementById('mobile-selected-container');
  container.style.display = 'flex';
}

function clearMobileSelection() {
  mobileSelectedFiles = [];
  document.getElementById('mobile-file-list').innerHTML = '';
  document.getElementById('mobile-choose-btn').style.display = '';
  document.getElementById('mobile-selected-container').style.display = 'none';
}

function showMobileDeviceSheet() {
  populateMobileSheet();
  document.getElementById('mobile-sheet-subtitle').textContent =
    `${mobileSelectedFiles.length} file${mobileSelectedFiles.length !== 1 ? 's' : ''} selected — tap a device to send`;
  document.getElementById('mobile-device-sheet').classList.add('active');
}

function populateMobileSheet() {
  const listEl = document.getElementById('mobile-sheet-device-list');
  listEl.innerHTML = '';
  devices.forEach(device => {
    const card = document.createElement('div');
    card.className = 'mobile-sheet-device-card';
    card.innerHTML = `
      <div class="mobile-sheet-device-icon">💻</div>
      <div>
        <div class="mobile-sheet-device-name">${escHtml(device.name)}</div>
        <div class="mobile-sheet-device-ip">${escHtml(device.host)}:${device.port}</div>
      </div>
    `;
    card.addEventListener('click', () => {
      document.getElementById('mobile-device-sheet').classList.remove('active');
      sendFilesToDevice([...mobileSelectedFiles], device);
      clearMobileSelection();
    });
    listEl.appendChild(card);
  });
}

// ─── Drop zone (desktop) ──────────────────────────────────────────────────────
function setupDropZone() {
  const zone = document.getElementById('drop-zone');
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-active'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-active'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault(); zone.classList.remove('drag-active');
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    if (devices.length === 0) { showToast('No devices found', 'Drop onto a device card in the sidebar', 'error'); return; }
    if (devices.length === 1) { sendFilesToDevice(files, devices[0]); }
    else { showToast('Select a device', 'Drag files directly onto a device in the sidebar', 'warn'); }
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
  for (const file of files) await sendOneFile(file, device);
}

async function sendOneFile(file, device) {
  const transferId = generateId();
  log('info', `Sending "${file.name}" to ${device.name}…`);
  setDeviceStatus(device.id, `Sending ${file.name}…`, 'sending');
  setDeviceProgress(device.id, 0);

  try {
    const { pc, dc } = await getOrCreateConnection(device, transferId);
    await waitForOpen(dc);

    dc.send(JSON.stringify({ type: 'meta', transferId, fromName: selfInfo.name, fileName: file.name, fileSize: file.size, mimeType: file.type }));

    const accepted = await waitForAcceptance(transferId);
    if (!accepted) {
      log('warn', `${device.name} declined "${file.name}"`);
      setDeviceStatus(device.id, 'Declined', 'idle');
      setDeviceProgress(device.id, -1);
      showToast('Transfer declined', `${device.name} declined "${file.name}"`, 'warn');
      return;
    }

    const CHUNK_SIZE = 64 * 1024;
    const BUFFER_THRESHOLD = 1024 * 1024;
    const total = file.size;
    let offset = 0, chunkIndex = 0;

    while (offset < total) {
      while (dc.bufferedAmount > BUFFER_THRESHOLD) await sleep(50);
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      const arrayBuffer = await slice.arrayBuffer();
      dc.send(JSON.stringify({ type: 'chunk-header', transferId, index: chunkIndex, size: arrayBuffer.byteLength, final: offset + arrayBuffer.byteLength >= total }));
      dc.send(arrayBuffer);
      offset += arrayBuffer.byteLength;
      chunkIndex++;
      setDeviceProgress(device.id, Math.round((offset / total) * 100));
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
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const dc = pc.createDataChannel('transfer', { ordered: true });
  dc.binaryType = 'arraybuffer';

  pc.onicecandidate = async ({ candidate }) => {
    if (candidate) await db.sendSignal({ targetId: device.id, type: 'ice-candidate', data: { candidate, transferId } }).catch(() => {});
  };

  devicePeerConns.set(transferId, pc);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await db.sendSignal({ targetId: device.id, type: 'offer', data: { sdp: offer, transferId } });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timeout (no answer)')), 15000);
    pendingTransfers.set(`answer-${transferId}`, {
      resolve: (answer) => { clearTimeout(timeout); pc.setRemoteDescription(answer).then(resolve).catch(reject); },
      reject
    });
  });

  return { pc, dc };
}

// ─── Signal handling ──────────────────────────────────────────────────────────
async function handleSignal({ from, type, data }) {
  if (type === 'offer') { await handleOffer(from, data); }
  else if (type === 'answer') {
    const pending = pendingTransfers.get(`answer-${data.transferId}`);
    if (pending) { pendingTransfers.delete(`answer-${data.transferId}`); pending.resolve(data.sdp); }
  } else if (type === 'ice-candidate') {
    const pc = devicePeerConns.get(data.transferId);
    if (pc && data.candidate) pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
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
    if (candidate) await db.sendSignal({ targetId: fromId, type: 'ice-candidate', data: { candidate, transferId } }).catch(() => {});
  };

  pc.ondatachannel = ({ channel }) => { channel.binaryType = 'arraybuffer'; setupReceiverChannel(channel, fromId, transferId); };

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await db.sendSignal({ targetId: fromId, type: 'answer', data: { sdp: answer, transferId } });
}

function setupReceiverChannel(channel, fromId, transferId) {
  let pendingHeader = null;

  channel.onmessage = async ({ data }) => {
    if (data instanceof ArrayBuffer) {
      if (!pendingHeader) return;
      const { tId, index, final } = pendingHeader;
      pendingHeader = null;
      const state = incomingTransfers.get(tId);
      if (!state) return;
      state.received += data.byteLength;
      const pct = Math.min(100, Math.round((state.received / state.fileSize) * 100));
      log('info', `Receiving… ${pct}%`);
      if (state.fileWriter) {
        try { await state.fileWriter.write(data); }
        catch (err) { log('error', `Disk write failed for "${state.fileName}": ${err.message}`); await state.fileWriter.abort().catch(() => {}); state.fileWriter = null; state.chunks = []; }
      } else { state.chunks.push(data); }
      if (final) {
        if (state.fileWriter) {
          try { await state.fileWriter.close(); log('success', `Received "${state.fileName}" from ${state.fromName} — saved to disk`); showToast('File received!', `"${state.fileName}" saved to disk`, 'success'); }
          catch (err) { log('error', `Failed to finalise disk write for "${state.fileName}": ${err.message}`); }
        } else {
          try {
            const blob = new Blob(state.chunks);
            const { filePath } = await db.saveFile({ fileName: state.fileName, blob });
            log('success', `Received "${state.fileName}" from ${state.fromName} → ${filePath}`);
            showToast('File received!', `"${state.fileName}" saved`, 'success');
          } catch (err) { log('error', `Failed to save "${state.fileName}": ${err.message}`); }
        }
        incomingTransfers.delete(tId);
      }
      return;
    }

    let msg; try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'meta') {
      incomingTransfers.set(msg.transferId, { transferId: msg.transferId, fileName: msg.fileName, fileSize: msg.fileSize, fromName: msg.fromName, fileWriter: null, chunks: [], received: 0 });
      const { accepted, fileWriter } = await showIncomingModal(msg.fromName, msg.fileName, msg.fileSize);
      log(accepted ? 'info' : 'warn', accepted ? `Accepted "${msg.fileName}" from ${msg.fromName}` : `Declined "${msg.fileName}" from ${msg.fromName}`);
      if (accepted && fileWriter) { const state = incomingTransfers.get(msg.transferId); if (state) state.fileWriter = fileWriter; }
      await db.sendSignal({ targetId: fromId, type: accepted ? 'transfer-accepted' : 'transfer-declined', data: { transferId: msg.transferId } });
      if (!accepted) incomingTransfers.delete(msg.transferId);
    } else if (msg.type === 'chunk-header') {
      pendingHeader = { tId: msg.transferId, index: msg.index, final: msg.final };
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
    const timeout = setTimeout(() => { pendingTransfers.delete(`accept-${transferId}`); reject(new Error('Acceptance timeout')); }, 30000);
    pendingTransfers.set(`accept-${transferId}`, {
      resolve: (v) => { clearTimeout(timeout); resolve(v); },
      reject: (e) => { clearTimeout(timeout); reject(e); }
    });
  });
}

function generateId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escHtml(str) { return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function cssId(str) { return str.replace(/[^a-z0-9]/gi, '_'); }
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
  toast.innerHTML = `<div class="toast-icon">${icons[type] || 'ℹ️'}</div><div class="toast-body"><div class="toast-title">${escHtml(title)}</div><div class="toast-desc">${escHtml(desc)}</div></div>`;
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
  // Expand panel when new log arrives
  const panel = document.getElementById('activity-panel');
  if (panel && !isMobile()) panel.classList.remove('collapsed');
  while (logEl.children.length > 100) logEl.removeChild(logEl.lastChild);
}

// ─── Incoming transfer modal ──────────────────────────────────────────────────
function showIncomingModal(fromName, fileName, fileSize) {
  return new Promise((resolve) => {
    document.getElementById('modal-desc').textContent = `${fromName} wants to send you a file`;
    document.getElementById('modal-file-name').textContent = fileName;
    document.getElementById('modal-file-size').textContent = formatBytes(fileSize);

    const hasFSA = typeof window.showSaveFilePicker === 'function';
    let hintEl = document.getElementById('modal-save-hint');
    if (!hintEl) {
      hintEl = document.createElement('div');
      hintEl.id = 'modal-save-hint';
      hintEl.style.cssText = 'font-size:12px;color:#888;margin-top:6px;';
      document.getElementById('modal-file-size').insertAdjacentElement('afterend', hintEl);
    }
    hintEl.textContent = hasFSA ? '💾 Will save directly to disk' : '📥 Will download when transfer is complete';

    const overlay = document.getElementById('modal-overlay');
    overlay.classList.add('active');
    const acceptBtn = document.getElementById('modal-accept');
    const declineBtn = document.getElementById('modal-decline');
    const cleanup = () => overlay.classList.remove('active');

    acceptBtn.onclick = async () => {
      cleanup();
      let fileWriter = null;
      if (typeof window.showSaveFilePicker === 'function') {
        try { const handle = await window.showSaveFilePicker({ suggestedName: fileName }); fileWriter = await handle.createWritable(); } catch { fileWriter = null; }
      }
      resolve({ accepted: true, fileWriter });
    };
    declineBtn.onclick = () => { cleanup(); resolve({ accepted: false, fileWriter: null }); };
  });
}

// ─── Contacts ─────────────────────────────────────────────────────────────────
function getContacts() { try { return JSON.parse(localStorage.getItem('dropbeam-contacts') || '[]'); } catch { return []; } }
function saveContacts(contacts) { localStorage.setItem('dropbeam-contacts', JSON.stringify(contacts)); }

function addContact(device) {
  const contacts = getContacts();
  if (contacts.find(c => c.id === device.id)) return;
  contacts.push({ id: device.id, name: device.name, addedAt: Date.now() });
  saveContacts(contacts);
  renderContacts();
  showToast('Contact saved', `${device.name} added to contacts`, 'success');
}

function removeContact(contactId) { saveContacts(getContacts().filter(c => c.id !== contactId)); renderContacts(); }

function setupContacts() {
  document.getElementById('save-contact-btn').addEventListener('click', () => {
    if (devices.length === 0) { showToast('No devices online', 'Connect to devices first to save them', 'warn'); return; }
    devices.forEach(d => addContact(d));
  });
  renderContacts();
}

function renderContacts() {
  const contacts = getContacts();
  const list = document.getElementById('contact-list');
  if (!list) return;
  if (contacts.length === 0) { list.innerHTML = '<div class="no-devices" style="padding:16px;font-size:12px;">No saved contacts yet</div>'; return; }

  list.innerHTML = '';
  const onlineIds = new Set(devices.map(d => d.id));

  contacts.forEach(contact => {
    const isOnline = onlineIds.has(contact.id);
    const hasQueued = [...queuedTransfers.values()].some(q => q.recipientId === contact.id);
    const card = document.createElement('div');
    card.className = `device-card${isOnline ? '' : ' offline'}`;
    card.dataset.contactId = contact.id;
    card.innerHTML = `
      <div class="device-name">${isOnline ? '💻' : '💤'} ${escHtml(contact.name)}${hasQueued ? '<span class="queued-badge">Queued</span>' : ''}</div>
      <div class="device-ip">${isOnline ? 'Online' : 'Offline'}</div>
      <div class="contact-actions">
        <button class="btn-icon remove-contact-btn" data-id="${escHtml(contact.id)}" title="Remove contact">Remove</button>
      </div>
    `;
    card.querySelector('.remove-contact-btn').addEventListener('click', (e) => { e.stopPropagation(); removeContact(contact.id); });
    if (!isOnline) {
      card.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); card.classList.add('drag-over'); });
      card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
      card.addEventListener('drop', (e) => {
        e.preventDefault(); e.stopPropagation(); card.classList.remove('drag-over');
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) queueFilesForContact(files, contact);
      });
    }
    list.appendChild(card);
  });
}

async function queueFilesForContact(files, contact) {
  const filesMeta = files.map(f => ({ name: f.name, size: f.size, mimeType: f.type || 'application/octet-stream' }));
  const base = db.getApiBase ? db.getApiBase() : `http://${location.host}`;
  try {
    const res = await fetch(`${base}/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipientId: contact.id, senderId: selfInfo.id, senderName: selfInfo.name, files: filesMeta })
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Queue failed'); }
    const { transferId } = await res.json();
    queuedTransfers.set(transferId, { recipientId: contact.id, files, contact });
    log('info', `Queued ${files.length} file(s) for ${contact.name} — waiting for them to come online`);
    showToast('Transfer queued', `Waiting for ${contact.name} to come online`, 'info');
    renderContacts();
  } catch (err) {
    log('error', `Failed to queue transfer: ${err.message}`);
    showToast('Queue failed', err.message, 'error');
  }
}

// ─── Pending transfers banner & modal ─────────────────────────────────────────
function showPendingBanner(transfers) {
  const banner = document.getElementById('pending-banner');
  if (!banner) return;
  const total = transfers.reduce((n, t) => n + (t.files ? t.files.length : 1), 0);
  const senders = [...new Set(transfers.map(t => t.senderName))].join(', ');
  document.getElementById('pending-banner-text').textContent = `${total} file${total !== 1 ? 's' : ''} waiting from ${senders}`;
  banner.classList.add('active');
}

function setupPendingModal() {
  const overlay = document.getElementById('pending-modal-overlay');
  if (!overlay) return;
  document.getElementById('pending-banner-close').addEventListener('click', () => document.getElementById('pending-banner').classList.remove('active'));
  document.getElementById('pending-banner-view').addEventListener('click', () => showPendingModal());
  document.getElementById('pending-modal-close').addEventListener('click', () => overlay.classList.remove('active'));
}

function showPendingModal() {
  const overlay = document.getElementById('pending-modal-overlay');
  const itemsEl = document.getElementById('pending-modal-items');
  if (!overlay || !itemsEl) return;
  itemsEl.innerHTML = '';
  serverPendingTransfers.forEach(transfer => {
    const filesSummary = transfer.files ? transfer.files.map(f => `${f.name} (${formatBytes(f.size)})`).join(', ') : 'Unknown files';
    const item = document.createElement('div');
    item.className = 'modal-pending-item';
    item.innerHTML = `
      <div class="item-sender">From: ${escHtml(transfer.senderName)}</div>
      <div class="item-files">${escHtml(filesSummary)}</div>
      <div class="item-actions">
        <button class="btn btn-accept" data-tid="${escHtml(transfer.transferId)}" data-sid="${escHtml(transfer.senderId)}">Accept</button>
        <button class="btn btn-decline" data-tid="${escHtml(transfer.transferId)}">Decline</button>
      </div>
    `;
    item.querySelector('.btn-accept').addEventListener('click', async (e) => {
      const tid = e.target.dataset.tid; const sid = e.target.dataset.sid;
      db.sendWs({ action: 'notify-sender', senderId: sid, transferId: tid });
      const base = db.getApiBase ? db.getApiBase() : `http://${location.host}`;
      await fetch(`${base}/queue/${tid}`, { method: 'DELETE' }).catch(() => {});
      serverPendingTransfers = serverPendingTransfers.filter(t => t.transferId !== tid);
      log('info', `Accepted queued transfer ${tid} from ${transfer.senderName}`);
      item.remove();
      if (serverPendingTransfers.length === 0) { document.getElementById('pending-banner').classList.remove('active'); overlay.classList.remove('active'); }
    });
    item.querySelector('.btn-decline').addEventListener('click', async (e) => {
      const tid = e.target.dataset.tid;
      const base = db.getApiBase ? db.getApiBase() : `http://${location.host}`;
      await fetch(`${base}/queue/${tid}`, { method: 'DELETE' }).catch(() => {});
      serverPendingTransfers = serverPendingTransfers.filter(t => t.transferId !== tid);
      log('warn', `Declined queued transfer from ${transfer.senderName}`);
      item.remove();
      if (serverPendingTransfers.length === 0) { document.getElementById('pending-banner').classList.remove('active'); overlay.classList.remove('active'); }
    });
    itemsEl.appendChild(item);
  });
  overlay.classList.add('active');
}

// ─── Auto-Update Banner (Electron only) ──────────────────────────────────────
(function setupUpdateBanner() {
  if (!window.dropbeam || !window.dropbeam.onUpdateReady) return;
  window.dropbeam.onUpdateAvailable(() => { console.log('[updater] Update available — downloading in background...'); });
  window.dropbeam.onUpdateReady(() => {
    const existing = document.getElementById('update-banner');
    if (existing) return;
    const banner = document.createElement('div');
    banner.id = 'update-banner';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#6c63ff;color:#fff;padding:10px 20px;display:flex;align-items:center;justify-content:space-between;font-family:inherit;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.4)';
    banner.innerHTML = `<span>⬆️ Update ready — restart to install</span><button id="update-restart-btn" style="background:#fff;color:#6c63ff;border:none;border-radius:6px;padding:6px 16px;cursor:pointer;font-weight:600;font-size:13px;margin-left:16px;">Restart &amp; Install</button>`;
    document.body.prepend(banner);
    document.getElementById('update-restart-btn').addEventListener('click', () => window.dropbeam.restartAndInstall());
  });
})();

// ─── Start ────────────────────────────────────────────────────────────────────
init().catch(console.error);

// ─── DropBeam Connect — User badge & connect status ──────────────────────────
(async function setupDropbeamConnect() {
  if (!window.dropbeam || !window.dropbeam.auth) return;

  const badge = document.getElementById('user-badge');
  const avatar = document.getElementById('user-avatar');
  const nameEl = document.getElementById('user-display-name');
  const dot = document.getElementById('connect-dot');
  const statusText = document.getElementById('connect-status-text');
  const signoutBtn = document.getElementById('signout-btn');

  function setConnectStatus(status) {
    dot.className = 'connect-dot';
    if (status === 'connected') {
      dot.classList.add('connected');
      statusText.textContent = '🔒 Connected';
    } else if (status === 'connecting') {
      dot.classList.add('connecting');
      statusText.textContent = 'Connecting…';
    } else if (status === 'not-installed') {
      dot.classList.add('not-installed');
      statusText.textContent = 'Setup required';
    } else {
      statusText.textContent = 'Not connected';
    }
  }

  // Load user info
  try {
    const user = await window.dropbeam.auth.getUser();
    if (user && badge) {
      badge.style.display = 'flex';
      nameEl.textContent = user.name || user.email || 'User';
      avatar.textContent = (user.name || user.email || 'U').charAt(0).toUpperCase();
      setConnectStatus('connecting');
    }
  } catch {}

  // Listen for connect status updates from main process
  if (window.dropbeam.auth.onConnectStatus) {
    window.dropbeam.auth.onConnectStatus((status) => setConnectStatus(status));
  }
  if (window.dropbeam.tailscale && window.dropbeam.tailscale.onConnectStatus) {
    window.dropbeam.tailscale.onConnectStatus((status) => setConnectStatus(status));
  }

  // Sign out
  if (signoutBtn) {
    signoutBtn.addEventListener('click', async () => {
      if (confirm('Sign out of DropBeam Connect?')) {
        await window.dropbeam.auth.logout();
      }
    });
  }
})();
