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
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),

  // Tailscale
  tailscale: {
    getPeers: () => ipcRenderer.invoke('tailscale:getPeers'),
    sendFile: (args) => ipcRenderer.invoke('tailscale:sendFile', args),
    onProgress: (cb) => ipcRenderer.on('tailscale:progress', (e, pct) => cb(pct)),
    offProgress: () => ipcRenderer.removeAllListeners('tailscale:progress'),
    onConnectStatus: (cb) => ipcRenderer.on('tailscale:connectStatus', (e, status) => cb(status))
  },

  // Internet (Render)
  internet: {
    getDevices: () => ipcRenderer.invoke('internet:getDevices'),
    sendSignal: (payload) => ipcRenderer.invoke('internet:sendSignal', payload),
    onDevicesUpdated: (cb) => ipcRenderer.on('internet-devices-updated', (e, devices) => cb(devices)),
    onMessage: (cb) => ipcRenderer.on('render-ws-message', (e, msg) => cb(msg))
  },

  // Auth & DropBeam Connect
  auth: {
    saveToken: (token, user) => ipcRenderer.invoke('auth:saveToken', { token, user }),
    clearToken: () => ipcRenderer.invoke('auth:clearToken'),
    getUser: () => ipcRenderer.invoke('auth:getUser'),
    loadApp: () => ipcRenderer.invoke('auth:loadApp'),
    getServerUrl: () => ipcRenderer.sendSync('auth:getServerUrl'),
    logout: () => ipcRenderer.invoke('auth:logout'),
    onConnectStatus: (cb) => ipcRenderer.on('tailscale:connectStatus', (e, status) => cb(status))
  }
});
