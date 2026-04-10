const { app, BrowserWindow, ipcMain, session, Menu, screen } = require('electron');

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('gtk-version', '3');
}

const path = require('path');
const fs = require('fs');
const os = require('os');
const { powerMonitor } = require('electron');

let mainWindow;
let sessionPanel;
let reservationWindow;
let lastUsername = 'User';
let loginWatcherInterval = null;
let focusMonitorInterval = null;
let heartbeatInterval = null;
let secondaryLockWindows = [];

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
  const platform = os.platform();
  const release = os.release();
  const hostname = os.hostname();
  const appVersion = app.getVersion();

  const sendHeartbeat = async () => {
    try {
      await fetch(
        `https://openinstrument.com/api/instruments/${instrumentUuid}/heartbeat`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            timestamp: new Date().toISOString(),
            os: { platform, release, hostname },
            app_version: appVersion
          })
        }
      );
    } catch (err) {
      console.error('Heartbeat failed:', err);
    }
  };

  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }
  sendHeartbeat(); // Send immediately on start
  heartbeatInterval = setInterval(sendHeartbeat, intervalMs);
}

// Cleanup function for previous session
async function cleanupPreviousSession(uuid) {
  try {
    await fetch('https://openinstrument.com/api/sessions/cleanup', {
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

function createSecondaryLockWindows() {
  const displays = screen.getAllDisplays();
  const primaryDisplay = screen.getPrimaryDisplay();

  displays.forEach(display => {
    if (display.id === primaryDisplay.id) return;

    const { x, y, width, height } = display.bounds;
    const lockWin = new BrowserWindow({
      x, y, width, height,
      frame: false,
      resizable: false,
      movable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      backgroundColor: '#000000',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      }
    });
    lockWin.loadURL('data:text/html,<style>html,body{margin:0;padding:0;background:black;width:100%;height:100%}</style>');
    secondaryLockWindows.push(lockWin);
  });
}

function clearSecondaryLockWindows() {
  secondaryLockWindows.forEach(win => {
    if (win && !win.isDestroyed()) {
      win.allowClose = true;
      win.close();
      win.destroy();
    }
  });
  secondaryLockWindows = [];
}

function createLoginWindow() {
  clearSecondaryLockWindows();

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

    // Add crash detection and recovery
    mainWindow.webContents.on('render-process-gone', (event, details) => {
      console.error('Renderer process crashed:', details);
      mainWindow.reload();
    });

    mainWindow.webContents.on('unresponsive', () => {
      console.error('Window became unresponsive');
      mainWindow.reload();
    });
  } else {
    startHeartbeat(loadInstrumentUuid());
    // UUID is present, launch into full kiosk mode

    if (process.platform === 'darwin') {
      // macOS: use maximized window with simpleFullScreen to avoid separate Space
      const { width, height } = screen.getPrimaryDisplay().bounds;
      mainWindow = new BrowserWindow({
        width: width,
        height: height,
        x: 0,
        y: 0,
        frame: false,
        backgroundColor: '#111827',
        alwaysOnTop: true,
        resizable: false,
        fullscreenable: false,
        autoHideMenuBar: true,
        skipTaskbar: true,
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
        }
      });
      mainWindow.setSimpleFullScreen(true);
    } else {
      // Windows/Linux: use traditional fullscreen + kiosk mode
      mainWindow = new BrowserWindow({
        fullscreen: true,
        frame: false,
        kiosk: true,
        backgroundColor: '#111827',
        alwaysOnTop: true,
        resizable: false,
        autoHideMenuBar: true,
        skipTaskbar: true,
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
        }
      });
    }

    const welcomeUrl = `https://openinstrument.com/desktop-welcome?instrument_uuid=${instrumentUuid}`;
    mainWindow.loadURL(welcomeUrl);
    createSecondaryLockWindows();

    // Handle network failures by retrying
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // -3 is ERR_ABORTED, usually harmless (e.g. new navigation started)
      if (isMainFrame && errorCode !== -3) {
        console.log(`Page failed to load (${errorCode}: ${errorDescription}). Retrying in 10s...`);
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.loadURL(welcomeUrl);
          }
        }, 10000);
      }
    });

    // Add crash detection and recovery
    mainWindow.webContents.on('render-process-gone', (event, details) => {
      console.error('Renderer process crashed:', details);
      mainWindow.reload();
    });

    mainWindow.webContents.on('unresponsive', () => {
      console.error('Window became unresponsive');
      mainWindow.reload();
    });

    // Health check every 5 minutes to detect black screen issues
    setInterval(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.executeJavaScript('document.readyState')
          .catch(err => {
            console.error('Health check failed, reloading window:', err);
            mainWindow.reload();
          });
      }
    }, 300000); // 5 minutes

    mainWindow.webContents.once('did-finish-load', () => {
      if (loginWatcherInterval) {
        clearInterval(loginWatcherInterval);
      }

      // Start focus monitor to prevent app switching
      if (focusMonitorInterval) {
        clearInterval(focusMonitorInterval);
      }

      focusMonitorInterval = setInterval(() => {
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
          console.log('🔒 Window lost focus — refocusing');
          mainWindow.show();
          mainWindow.focus();
          mainWindow.moveTop();
          if (process.platform === 'darwin') {
            app.focus({ steal: true });
          }
        }
      }, 500); // Check every 500ms

      // Removed update check on load to prevent update checks on app launch

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
  const windowHeight = 84;

  const x = Math.floor((screenWidth - windowWidth) / 2);
  // On macOS, position below menu bar (~30px); on other platforms, at top
  const y = process.platform === 'darwin' ? 30 : 0;

  sessionPanel = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: x,
    y: y,
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

  if (process.platform === 'darwin') {
    // macOS: use maximized window with simpleFullScreen to avoid separate Space
    const { width, height } = screen.getPrimaryDisplay().bounds;
    reservationWindow = new BrowserWindow({
      width: width,
      height: height,
      x: 0,
      y: 0,
      backgroundColor: '#111827',
      frame: false,
      alwaysOnTop: true,
      resizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    reservationWindow.setSimpleFullScreen(true);
  } else {
    // Windows/Linux: use traditional fullscreen + kiosk mode
    reservationWindow = new BrowserWindow({
      fullscreen: true,
      frame: false,
      kiosk: true,
      backgroundColor: '#111827',
      alwaysOnTop: true,
      resizable: false,
      autoHideMenuBar: true,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
  }

  reservationWindow.loadFile('renderer/reservation.html');

  reservationWindow.webContents.once('did-finish-load', () => {
    reservationWindow.webContents.send('reservation-data', {
      token,
      username,
      instrumentUuid
    });
  });
}

function createBypassPanel(token) {
  clearSecondaryLockWindows();

  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  const windowWidth = 1080;
  const windowHeight = 84;

  const x = Math.floor((screenWidth - windowWidth) / 2);
  // On macOS, position below menu bar (~30px); on other platforms, at top
  const y = process.platform === 'darwin' ? 30 : 0;

  sessionPanel = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: x,
    y: y,
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
    const response = await fetch('https://openinstrument.com/api/sessions/start', {
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
    clearSecondaryLockWindows();
    createSessionPanel(token, lastUsername, sessionId, endTime);

  } catch (err) {
    console.error('Start session error:', err);
  }
});

ipcMain.on('end-session', async (event, { token, sessionId }) => {
  try {
    await fetch('https://openinstrument.com/api/sessions/stop', {
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

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      mainWindow.show();
    }
  });

  app.whenReady().then(async () => {
    app.setLoginItemSettings({
      openAtLogin: true,
      path: app.getPath('exe')
    });
    if (process.platform === 'linux') {
      const autostartPath = path.join(os.homedir(), '.config', 'autostart');
      const autostartFile = path.join(autostartPath, 'openinstrument.desktop');
      const appDesktopFile = path.join(process.resourcesPath, 'openinstrument.desktop');

      fs.mkdirSync(autostartPath, { recursive: true });

      if (!fs.existsSync(autostartFile)) {
        fs.copyFile(appDesktopFile, autostartFile, err => {
          if (err) {
            console.error('Failed to copy autostart .desktop file:', err);
          } else {
            console.log('✅ Autostart .desktop file installed.');
          }
        });
      }
    }

    const { powerSaveBlocker } = require('electron');
    const blockerId = powerSaveBlocker.start('prevent-display-sleep')

    if (process.platform === 'darwin') {
      app.dock.hide();
    }
    Menu.setApplicationMenu(null);
    const instUuid = loadInstrumentUuid();
    if (instUuid) {
      await cleanupPreviousSession(instUuid);
    }

    createLoginWindow();

    powerMonitor.on('resume', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('💤 System resumed — reloading main window');
        mainWindow.reload();
        mainWindow.show();
        mainWindow.focus();
        if (process.platform === 'darwin') {
          mainWindow.setSimpleFullScreen(true);
        } else {
          mainWindow.setKiosk(true);
        }
      }
    });

    powerMonitor.on('unlock-screen', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('🔓 Screen unlocked — reloading window');
        mainWindow.reload();
        mainWindow.show();
        mainWindow.focus();
        if (process.platform === 'darwin') {
          mainWindow.setSimpleFullScreen(true);
        } else {
          mainWindow.setKiosk(true);
        }
      }
    });
  });
}

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
  BrowserWindow.getAllWindows().forEach(win => {
    win.allowClose = true;
    win.close();
    win.destroy();
  });
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

    // Intercept Cmd+Tab on Mac to prevent app switching
    if (isMac && input.meta && input.code === 'Tab') {
      event.preventDefault();
      console.log('🚫 Cmd+Tab blocked — refocusing window');
      window.show();
      window.focus();
      window.moveTop();
      return;
    }

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

    const adminBypass =
      (isMac &&
        input.meta &&
        input.alt &&
        input.code === 'KeyB' &&
        !input.control &&
        !input.shift) ||
      (!isMac &&
        input.control &&
        input.shift &&
        input.code === 'KeyB' &&
        !input.meta &&
        !input.alt);

    if (adminBypass) {
      console.log('🔐 Admin bypass combo triggered — entering bypass mode.');
      if (loginWatcherInterval) {
        clearInterval(loginWatcherInterval);
        loginWatcherInterval = null;
      }
      BrowserWindow.getAllWindows().forEach(win => {
        win.allowClose = true;
        win.close();
        win.destroy();
      });
      mainWindow = null;
      reservationWindow = null;
      session.defaultSession.clearStorageData({ storages: ['cookies'] }).then(() => {
        createBypassPanel(null);
      });
    }
  });
});
app.on('window-all-closed', (event) => {
  // Do nothing here to prevent app from quitting when all windows are closed
});
