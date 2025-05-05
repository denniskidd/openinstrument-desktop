const { app, BrowserWindow, ipcMain, session, Menu, screen, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');
const log = require('electron-log');

autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';

autoUpdater.setFeedURL({
  provider: 'generic',
  url: 'https://openrequest-secure-desktop.s3.us-east-1.amazonaws.com/updates/' 
});

// Update events
autoUpdater.on('checking-for-update', () => {
  console.log('AutoUpdater: Checking for update...');
});
autoUpdater.on('update-available', info => {
  console.log('AutoUpdater: Update available:', info.version);
});
autoUpdater.on('update-not-available', () => {
  console.log('AutoUpdater: No updates found.');
});
autoUpdater.on('download-progress', progress => {
  console.log(`AutoUpdater: Downloading ${Math.round(progress.percent)}%`);
});
autoUpdater.on('update-downloaded', () => {
  console.log('AutoUpdater: Update downloaded; prompting user…');
  autoUpdater.quitAndInstall();
});
autoUpdater.on('error', err => {
  console.error('AutoUpdater error:', err);
});

let mainWindow;
let sessionPanel;
let reservationWindow;
let lastUsername = 'User';
let loginWatcherInterval = null;

function getInstrumentConfigPath() {
  return path.join(app.getPath('userData'), 'instrument-config.json');
}

function loadInstrumentUuid() {
  const configPath = getInstrumentConfigPath();
  if (fs.existsSync(configPath)) {
    const data = fs.readFileSync(configPath);
    return JSON.parse(data).instrumentUuid;
  }
  return null;
}

function saveInstrumentConfig(config) {
  fs.writeFileSync(
    getInstrumentConfigPath(),
    JSON.stringify(config, null, 2) // nicely formatted
  );
}

function loadInstrumentConfig() {
  const configPath = getInstrumentConfigPath();
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  return null;
}

function startHeartbeat(instrumentUuid) {
  const intervalMs = 300_000; // 5 minutes
  const platform   = os.platform();
  const release    = os.release();
  const hostname   = os.hostname();
  const appVersion = app.getVersion();

  const sendHeartbeat = async () => {
    try {
      await fetch(
        `https://openrequest.jh.edu/api/instruments/${instrumentUuid}/heartbeat`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            timestamp:   new Date().toISOString(),
            os:          { platform, release, hostname },
            app_version: appVersion
          })
        }
      );
    } catch (err) {
      console.error('Heartbeat failed:', err);
    }
  };

  sendHeartbeat(); // Send immediately on start
  setInterval(sendHeartbeat, intervalMs);
}

function scheduleSilentAutoUpdateCheck() {
  const instrumentUuid = loadInstrumentUuid();

  const checkUpdateIfIdle = async () => {
    // Only run update if app is on main login screen and no session is active
    if (
      mainWindow &&
      !sessionPanel &&
      !reservationWindow &&
      mainWindow.webContents &&
      mainWindow.webContents.getURL().includes('/desktop-welcome') &&
      instrumentUuid
    ) {
      try {
        await autoUpdater.checkForUpdates();
      } catch (err) {
        console.error('Silent update check failed:', err);
      }
    }
  };

  // Calculate milliseconds until next midnight
  const now = new Date();
  const nextMidnight = new Date();
  nextMidnight.setHours(24, 0, 0, 0);
  const initialDelay = nextMidnight - now;

  setTimeout(() => {
    checkUpdateIfIdle();
    setInterval(checkUpdateIfIdle, 24 * 60 * 60 * 1000); // Every 24h
  }, initialDelay);
}

// Cleanup function for previous session
async function cleanupPreviousSession(uuid) {
  try {
    await fetch('https://openrequest.jh.edu/api/sessions/cleanup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Instrument-UUID': uuid
      },
      body: JSON.stringify({ instrument_uuid: uuid })
    });
    console.log('Previous session cleaned up');
  } catch (err) {
    console.error('Failed cleanup:', err);
  }
}

function createLoginWindow() {
  if (mainWindow) {
    mainWindow.allowClose = true;
    mainWindow.close();
    mainWindow.destroy();
    mainWindow = null;
  }

  const instrumentUuid = loadInstrumentUuid();
 
  if (!instrumentUuid) {
    // No UUID yet, show a normal small setup window
    mainWindow = new BrowserWindow({
      width: 1080,
      height: 800,
      backgroundColor: '#111827', 
      resizable: false,
      fullscreenable: false,
      frame: false,
      autoHideMenuBar: true,    // Windows/Linux: hides the Alt-menu bar
      skipTaskbar: true,        // hides from Windows taskbar / Linux dock
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      }
    });

    mainWindow.loadFile('renderer/login.html');
  } else {
    startHeartbeat(loadInstrumentUuid());
    // UUID is present, launch into full kiosk mode
    mainWindow = new BrowserWindow({
      fullscreen: true,
      frame: false,
      kiosk: true,
      backgroundColor: '#111827', // <-- Tailwind "gray-900"
      alwaysOnTop: true,
      resizable: false,
      autoHideMenuBar: true,    // Windows/Linux: hides the Alt-menu bar
      skipTaskbar: true,        // hides from Windows taskbar / Linux dock
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      }
    });

    mainWindow.loadURL(`https://openrequest.jh.edu/desktop-welcome?instrument_uuid=${instrumentUuid}`);
    mainWindow.webContents.once('did-finish-load', () => {
      if (loginWatcherInterval) {
        clearInterval(loginWatcherInterval);
      }

      loginWatcherInterval = setInterval(() => {
        if (!mainWindow) return;

        const currentUrl = mainWindow.webContents.getURL();
        console.log('🔄 Checking URL:', currentUrl);

        if (!currentUrl.includes('/desktop-welcome')) {
          console.log('⌛ User is off welcome page. Resetting to welcome.');
          mainWindow.allowClose = true;
          mainWindow.close();
          mainWindow.destroy();
          mainWindow = null;
          createLoginWindow();
        } else {
          console.log('✅ User is still on welcome. No action needed.');
        }
      }, 5 * 60 * 1000); // every 5 minutes
    });
  }

  mainWindow.on('closed', () => mainWindow = null);
}

function createSessionPanel(token, username, sessionId, endTime) {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  const windowWidth = 1080;
  const windowHeight = 90;

  const x = Math.floor((screenWidth - windowWidth) / 2);
  const y = Math.floor((screenHeight - windowHeight) / 2);

  sessionPanel = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: x,
    y: 0,
    backgroundColor: '#111827', // <-- Tailwind "gray-900"
    fullscreen: false,
    frame: false, 
    alwaysOnTop: true,
    resizable: false,
    autoHideMenuBar: true,    // Windows/Linux: hides the Alt-menu bar
    skipTaskbar: true,        // hides from Windows taskbar / Linux dock
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  sessionPanel.focus();
  sessionPanel.show();

  sessionPanel.loadFile('renderer/panel.html');
  sessionPanel.webContents.once('did-finish-load', () => {
    sessionPanel.webContents.send('session-info', { token, username, sessionId, endTime });
  });
}

function createReservationWindow(token, username) {
  const instrumentUuid = loadInstrumentUuid();

  reservationWindow = new BrowserWindow({
    backgroundColor: '#111827', // <-- Tailwind "gray-900"
    fullscreen: true,
    frame: false,
    kiosk: true,
    alwaysOnTop: true,
    resizable: false,
    autoHideMenuBar: true,    // Windows/Linux: hides the Alt-menu bar
    skipTaskbar: true,        // hides from Windows taskbar / Linux dock
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  reservationWindow.loadFile('renderer/reservation.html');

  reservationWindow.webContents.once('did-finish-load', () => {
    reservationWindow.setFullScreen(true); // ensure fullscreen on Mac after load
    reservationWindow.webContents.send('reservation-data', {
      token,
      username,
      instrumentUuid
    });
  });
}

function createBypassPanel(token) {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  const windowWidth = 1080;
  const windowHeight = 90;

  const x = Math.floor((screenWidth - windowWidth) / 2);
  const y = Math.floor((screenHeight - windowHeight) / 2);

  sessionPanel = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: x,
    y: 0,
    frame: false,
    transparent: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    autoHideMenuBar: true,    // Windows/Linux: hides the Alt-menu bar
    skipTaskbar: true,        // hides from Windows taskbar / Linux dock
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  sessionPanel.loadFile('renderer/bypass.html');

  sessionPanel.webContents.once('did-finish-load', () => {
    sessionPanel.webContents.send('bypass-info', { token });
  });

  sessionPanel.on('closed', () => {
    sessionPanel = null;
  });
}

ipcMain.on('token-received', (event, msg) => {
  if (msg === 'logout-now') {
    if (reservationWindow) {
      reservationWindow.allowClose = true;
      reservationWindow.close();
      reservationWindow.destroy();
      reservationWindow = null;
    }
    if (sessionPanel) {
      sessionPanel.allowClose = true;
      sessionPanel.close();
      sessionPanel.destroy();
      sessionPanel = null;
    }
    session.defaultSession.clearStorageData({ storages: ['cookies'] }).then(() => {
      createLoginWindow();
    });
    return;
  }

  if (loginWatcherInterval) {
    clearInterval(loginWatcherInterval);
    loginWatcherInterval = null;
  }

  if (msg.startsWith('save-instrument:')) {
    const jsonString = msg.substring('save-instrument:'.length); // slice after "save-instrument:"
    const config = JSON.parse(jsonString);
    saveInstrumentConfig(config);
      // Properly restart app into fullscreen mode
      if (mainWindow) {
        mainWindow.allowClose = true;
        mainWindow.close();
        mainWindow.destroy();
        mainWindow = null;
      }
    createLoginWindow();
  } else {
    const { token, username } = JSON.parse(msg);
    lastUsername = username; 
    if (mainWindow) {
      mainWindow.allowClose = true;
      mainWindow.close();
      mainWindow.destroy();
      mainWindow = null;
    }
    createReservationWindow(token, username);
  }
});

ipcMain.on('start-session', async (event, { token, reservationId, endTime }) => {
  try {
    const response = await fetch('https://openrequest.jh.edu/api/sessions/start', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ reservation_id: reservationId })
    });

    const result = await response.json();
    const sessionId = result.session_id;

    if (reservationWindow) {
      reservationWindow.allowClose = true;
      reservationWindow.close();
      reservationWindow.destroy();
      reservationWindow = null;
    }
    createSessionPanel(token, lastUsername, sessionId, endTime);

  } catch (err) {
    console.error('Start session error:', err);
  }
});

ipcMain.on('end-session', async (event, { token, sessionId }) => {
  try {
    await fetch('https://openrequest.jh.edu/api/sessions/stop', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ session_id: sessionId })
    });

    if (sessionPanel) {
      sessionPanel.allowClose = true;
      sessionPanel.close();
      sessionPanel.destroy();
      sessionPanel = null;
    }

    // Clear cookies and storage data
    // This is important to ensure that the session is properly cleared
    // and that no sensitive data remains in the session.
    const ses = session.defaultSession;
    await ses.clearStorageData({ storages: ['cookies'] });

    createLoginWindow();

  } catch (err) {
    console.error('Failed to stop session or clear session:', err);
  }
});

ipcMain.on('start-bypass', async (event, { token }) => {
  if (reservationWindow) {
    reservationWindow.allowClose = true;
    reservationWindow.close();
    reservationWindow.destroy();
    reservationWindow = null;
  }

  // ✅ Clear cookies and storage data when exiting bypass mode
  try {
    await session.defaultSession.clearStorageData({ storages: ['cookies'] });
  } catch (error) {
    console.error('Failed to clear storage data after exiting bypass:', error);
  }

  createBypassPanel(token);
});

app.whenReady().then(async () => {
  app.setLoginItemSettings({
    openAtLogin: true,
    path: app.getPath('exe')
  });
  if (process.platform === 'darwin') {
    app.dock.hide();
  }
  Menu.setApplicationMenu(null);
  const instUuid = loadInstrumentUuid();
  if (instUuid) {
    await cleanupPreviousSession(instUuid);
  }
  createLoginWindow();
  scheduleSilentAutoUpdateCheck();
});

ipcMain.on('exit-bypass', () => {
  if (sessionPanel) {
    sessionPanel.allowClose = true;
    sessionPanel.close();
    sessionPanel.destroy();
    sessionPanel = null;
  }
  createLoginWindow();
});

ipcMain.on('app-exit', () => {
  app.quit();
});

app.on('browser-window-created', (_, window) => {
  window.setMenuBarVisibility(false);
  window.setAutoHideMenuBar(true);
  window.allowClose = false;

  window.on('close', (e) => {  
    if (!window.allowClose) {
      e.preventDefault(); // 🔒 prevent default close
    }
  });

  // Defer closable setting to allow close flag to be updated first
  setImmediate(() => {
    if (!window.allowClose) {
      window.setClosable(false);
    }
  });

  // Admin key combo works on all windows
  window.webContents.on('before-input-event', (event, input) => {
    const isMac = process.platform === 'darwin';

    const adminExit =
    (isMac &&
      input.meta &&
      input.alt &&
      input.code === 'KeyQ' &&
      !input.control &&
      !input.shift) ||
    (!isMac &&
      input.control &&
      input.shift &&
      input.code === 'KeyQ' &&
      !input.meta &&
      !input.alt);

    if (adminExit) {
      console.log('🔐 Admin key combo triggered — exiting app.');
      BrowserWindow.getAllWindows().forEach(win => {
        win.allowClose = true;
        win.close();
        win.destroy();
      });
      app.quit();
    }
  });
});
app.on('window-all-closed', (event) => {
  // Do nothing here to prevent app from quitting when all windows are closed
});
