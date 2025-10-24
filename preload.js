const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  sendToken: (token) => ipcRenderer.send('token-received', token),
  sendStartBypass: (data) => ipcRenderer.send('start-bypass', data),
  sendStartSession: (payload) => ipcRenderer.send('start-session', payload),
  sendStopSession: (payload) => ipcRenderer.send('end-session', payload),
  onReservationData: (callback) => ipcRenderer.on('reservation-data', (event, data) => callback(data)),
  onSessionInfo: (callback) => ipcRenderer.on('session-info', (event, data) => callback(data)),
  sendExitBypass: () => ipcRenderer.send('exit-bypass'),
  exitApp: () => ipcRenderer.send('app-exit'),
  sendManualUpdateCheck: () => ipcRenderer.send('manual-update-check'),
  checkForUpdateAvailable: () => ipcRenderer.invoke('check-update-available'),
  onUpdateProgress: (callback) => ipcRenderer.on('update-progress', (event, progress) => callback(progress)),
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (event, status) => callback(status)),
});

window.addEventListener('message', (event) => {
  console.log('📬 Message received in preload:', event.data);

  try {
    const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    console.log('✅ Parsed token object:', data);

    if (data.token) {
      ipcRenderer.send('token-received', JSON.stringify(data));
    }
  } catch (err) {
    console.error('❌ Token parse failed:', err);
  }
});

