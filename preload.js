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
  showEndConfirm: (payload) => ipcRenderer.send('show-end-confirm', payload),
  confirmEndSession: () => ipcRenderer.send('confirm-end-session'),
  cancelEndConfirm: () => ipcRenderer.send('cancel-end-confirm'),
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

