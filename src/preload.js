const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dropbeam', {
  getSelfInfo: () => ipcRenderer.invoke('get-self-info'),
  getDevices: () => ipcRenderer.invoke('get-devices'),
  sendSignal: (args) => ipcRenderer.invoke('send-signal', args),
  showTransferDialog: (args) => ipcRenderer.invoke('show-transfer-dialog', args),
  saveFile: (args) => ipcRenderer.invoke('save-file', args),
  readFile: (args) => ipcRenderer.invoke('read-file', args),

  onDevicesUpdated: (cb) => ipcRenderer.on('devices-updated', (e, devices) => cb(devices)),
  onSignalReceived: (cb) => ipcRenderer.on('signal-received', (e, data) => cb(data)),

  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),

  // Auto-update
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', () => cb()),
  onUpdateReady: (cb) => ipcRenderer.on('update-ready', () => cb()),
  restartAndInstall: () => ipcRenderer.send('restart-and-install'),

  // Tailscale
  tailscale: {
    getPeers: () => ipcRenderer.invoke('tailscale:getPeers'),
    sendFile: (args) => ipcRenderer.invoke('tailscale:sendFile', args),
    onProgress: (cb) => ipcRenderer.on('tailscale:progress', (e, pct) => cb(pct)),
    offProgress: () => ipcRenderer.removeAllListeners('tailscale:progress')
  },

  // Internet (Render)
  internet: {
    getDevices: () => ipcRenderer.invoke('internet:getDevices'),
    sendSignal: (payload) => ipcRenderer.invoke('internet:sendSignal', payload),
    onDevicesUpdated: (cb) => ipcRenderer.on('internet-devices-updated', (e, devices) => cb(devices)),
    onMessage: (cb) => ipcRenderer.on('render-ws-message', (e, msg) => cb(msg))
  }
});
