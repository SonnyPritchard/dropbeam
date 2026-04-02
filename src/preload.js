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

  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
});
