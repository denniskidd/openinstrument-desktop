const { app, BrowserWindow, ipcMain, session, Menu, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
log.info('App starting...');

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('gtk-version', '3');
}

const path = require('path');
const fs = require('fs');
const os = require('os');
const { powerMonitor } = require('electron');

let mainWindow;
let sessionPanel;
let loginWatcherInterval = null;
let focusMonitorInterval = null;
let heartbeatInterval = null;
let secondaryLockWindows = [];
let storedToken = null;
let confirmWindow = null;
let pendingStopPayload = null;
let updateDownloaded = false;

// ── Auto-updater ─────────────────────────────────────────────────────────────
// Load the GitHub token from a gitignored config file (never committed to source)
const updaterConfigPath = app.isPackaged
  ? path.join(process.resourcesPath, 'updater-config.json')
  : path.join(__dirname, 'updater-config.json');

let updaterToken = null;
try {
  updaterToken = JSON.parse(fs.readFileSync(updaterConfigPath, 'utf8')).token;
  console.log('🔑 Updater token loaded, isPackaged:', app.isPackaged);
} catch {
  console.warn('⚠️ updater-config.json not found at', updaterConfigPath, '— update checks will be skipped');
}

if (updaterToken) {
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'denniskidd',
    repo: 'openinstrument-desktop',
    private: true,
    token: updaterToken
  });
}
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = false; // we control install timing

autoUpdater.on('checking-for-update', () => {
  console.log('🔍 Checking for update...');
});

autoUpdater.on('update-available', (info) => {
  console.log('⬆️  Update available:', info.version);
});

autoUpdater.on('update-not-available', (info) => {
  console.log('✅ App is up to date:', info.version);
});

autoUpdater.on('update-downloaded', () => {
  updateDownloaded = true;
  console.log('✅ Update downloaded — will install at next session end or idle');

  // Already idle at login screen — schedule install after 60s buffer
  // (re-check at callback time in case a session started during the wait)
  if (!sessionPanel) {
    setTimeout(() => {
      if (!sessionPanel) {
        console.log('🔄 Idle — installing update now');
        autoUpdater.quitAndInstall(false, true);
      }
    }, 60_000);
  }
});

autoUpdater.on('error', (err) => {
  console.error('🚨 Auto-updater error:', err?.message ?? err);
});
// ─────────────────────────────────────────────────────────────────────────────

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


async function verifyInstrumentEnabled(uuid) {
  try {
    const res = await fetch(`https://openinstrument.com/api/instruments/${uuid}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.desktop_enabled ? data : null;
  } catch {
    return true; // fail open — if server unreachable, allow through
  }
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

function createDisabledWindow() {
  mainWindow = new BrowserWindow({
    width: 600,
    height: 300,
    backgroundColor: '#09090b',
    resizable: false,
    fullscreenable: false,
    frame: false,
    autoHideMenuBar: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });
  mainWindow.loadFile('renderer/disabled.html');
  mainWindow.allowClose = true;
  mainWindow.on('closed', () => mainWindow = null);
}

async function createLoginWindow() {
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
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      console.error('Renderer process crashed:', details);
      mainWindow.reload();
    });

    mainWindow.webContents.on('unresponsive', () => {
      console.error('Window became unresponsive');
      mainWindow.reload();
    });
  } else {
    startHeartbeat(instrumentUuid);

    const enabled = await verifyInstrumentEnabled(instrumentUuid);
    if (!enabled) {
      createDisabledWindow();
      return;
    }

    // UUID is present and desktop is enabled — launch into full kiosk mode

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
      // On Windows, use screen-saver level to render above the taskbar
      if (process.platform === 'win32') {
        mainWindow.setAlwaysOnTop(true, 'screen-saver');
      }
    }

    const welcomeUrl = `https://openinstrument.com/desktop-welcome?instrument_uuid=${instrumentUuid}`;
    mainWindow.loadURL(welcomeUrl);
    createSecondaryLockWindows();

    // Intercept navigation to /desktop-token — capture the Sanctum token and
    // immediately redirect the main window to /desktop-session.
    mainWindow.webContents.on('did-navigate', (_event, url) => {
      if (url.includes('/desktop-token')) {
        // Token arrives via postMessage → token-received IPC before this fires.
        // Only fall back to body scraping if postMessage didn't deliver it.
        if (storedToken) return;
        mainWindow.webContents.executeJavaScript(
          'document.body ? document.body.textContent.trim() : ""'
        ).then(text => {
          // Strip any non-ASCII characters that could come from CSS or page decoration
          const clean = text.replace(/[^\x20-\x7E]/g, '').trim();
          // Try to extract a JSON object anywhere in the text (page may have surrounding content)
          const jsonMatch = clean.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try {
              const parsed = JSON.parse(jsonMatch[0]);
              storedToken = parsed.token;
            } catch {
              storedToken = null;
            }
          }
          if (!storedToken) {
            // Last resort: assume the whole clean string is the raw token
            storedToken = clean;
          }
          if (loginWatcherInterval) {
            clearInterval(loginWatcherInterval);
            loginWatcherInterval = null;
          }
          const sessionUrl = `https://openinstrument.com/desktop-session?instrument_uuid=${instrumentUuid}`;
          mainWindow.loadURL(sessionUrl);
        }).catch(err => console.error('Failed to capture token:', err));
      }
    });

    // Intercept navigation to /desktop-session-started — extract session info,
    // hide the main window, and open the always-on-top panel.
    mainWindow.webContents.on('did-navigate', (_event, url) => {
      if (url.includes('/desktop-session-started')) {
        const parsed = new URL(url);
        const sessionId = parsed.searchParams.get('session_id');
        const userName = parsed.searchParams.get('user_name') || 'User';
        const sessionInstrumentUuid = parsed.searchParams.get('instrument_uuid') || instrumentUuid;

        console.log('✅ Session started — opening panel');

        if (loginWatcherInterval) {
          clearInterval(loginWatcherInterval);
          loginWatcherInterval = null;
        }
        if (focusMonitorInterval) {
          clearInterval(focusMonitorInterval);
          focusMonitorInterval = null;
        }

        mainWindow.allowClose = true;
        mainWindow.close();
        mainWindow.destroy();
        mainWindow = null;

        clearSecondaryLockWindows();
        createSessionPanel(storedToken, userName, sessionId, sessionInstrumentUuid);
      }
    });

    // Handle network failures by retrying
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
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
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
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
          } else if (process.platform === 'win32') {
            app.focus({ steal: true });
            mainWindow.setKiosk(true);
          }
        }
      }, 500); // Check every 500ms

      loginWatcherInterval = setInterval(() => {
        if (!mainWindow) return;

        const currentUrl = mainWindow.webContents.getURL();
        console.log('🔄 Checking URL:', currentUrl);

        const validPages = ['/desktop-welcome', '/desktop-login', '/desktop-session'];
        const onValidPage = validPages.some(p => currentUrl.includes(p));

        if (!onValidPage) {
          console.log('⌛ User is off a valid page. Resetting to welcome.');
          mainWindow.allowClose = true;
          mainWindow.close();
          mainWindow.destroy();
          mainWindow = null;
          createLoginWindow();
        } else {
          console.log('✅ User is on a valid page. No action needed.');
        }
      }, 5 * 60 * 1000); // every 5 minutes
    });
  }

  mainWindow.on('closed', () => mainWindow = null);
}

function createSessionPanel(token, username, sessionId, instrumentUuid) {
  const { width: screenWidth } = screen.getPrimaryDisplay().workAreaSize;

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
    backgroundColor: '#09090b',
    fullscreen: false,
    frame: false,
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
  if (process.platform === 'win32') {
    sessionPanel.setAlwaysOnTop(true, 'screen-saver');
  }
  sessionPanel.focus();
  sessionPanel.show();

  sessionPanel.loadFile('renderer/panel.html');
  sessionPanel.webContents.once('did-finish-load', () => {
    sessionPanel.webContents.send('session-info', { token, username, sessionId, instrumentUuid });
  });
}


function createBypassPanel(token) {
  clearSecondaryLockWindows();

  const { width: screenWidth } = screen.getPrimaryDisplay().workAreaSize;

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

ipcMain.on('token-received', (_event, msg) => {
  // Capture the Sanctum token posted by the web page via postMessage
  try {
    const parsed = typeof msg === 'string' ? JSON.parse(msg) : msg;
    if (parsed?.token) {
      storedToken = parsed.token;
      console.log('✅ Token stored from postMessage:', `${storedToken.substring(0, 8)}...`);
      return;
    }
  } catch {
    // not JSON — fall through to other message types
  }

  if (msg === 'logout-now') {
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
    const jsonString = msg.substring('save-instrument:'.length);
    const config = JSON.parse(jsonString);
    saveInstrumentConfig(config);
    if (mainWindow) {
      mainWindow.allowClose = true;
      mainWindow.close();
      mainWindow.destroy();
      mainWindow = null;
    }
    createLoginWindow();
  }
});


function createConfirmWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  confirmWindow = new BrowserWindow({
    width: 360,
    height: 200,
    x: Math.floor((width - 360) / 2),
    y: Math.floor((height - 200) / 2),
    backgroundColor: '#18181b',
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });
  confirmWindow.loadFile('renderer/confirm.html');
  confirmWindow.allowClose = true;
  confirmWindow.on('closed', () => confirmWindow = null);
}

ipcMain.on('show-end-confirm', (_event, payload) => {
  pendingStopPayload = payload;
  createConfirmWindow();
});

ipcMain.on('cancel-end-confirm', () => {
  if (confirmWindow) {
    confirmWindow.close();
    confirmWindow = null;
  }
  pendingStopPayload = null;
});

ipcMain.on('confirm-end-session', async () => {
  if (confirmWindow) {
    confirmWindow.close();
    confirmWindow = null;
  }

  const { token, sessionId } = pendingStopPayload || {};
  pendingStopPayload = null;

  if (!token || !sessionId) {
    console.error('confirm-end-session: missing token or sessionId', { token: !!token, sessionId });
    return;
  }

  const payload = { session_id: sessionId };

  try {
    const response = await fetch('https://openinstrument.com/api/sessions/stop', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const responseText = await response.text();
      console.error('Stop session API error:', response.status, responseText);
    }

    if (sessionPanel) {
      sessionPanel.allowClose = true;
      sessionPanel.close();
      sessionPanel.destroy();
      sessionPanel = null;
    }

    storedToken = null;
    await session.defaultSession.clearStorageData({ storages: ['cookies'] });

    if (updateDownloaded) {
      console.log('🔄 Update pending — installing at session end');
      autoUpdater.quitAndInstall(false, true);
    } else {
      createLoginWindow();
    }

  } catch (err) {
    console.error('Failed to stop session:', err);
  }
});

ipcMain.on('end-session', async (_event, { token, sessionId }) => {
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

    storedToken = null;
    const ses = session.defaultSession;
    await ses.clearStorageData({ storages: ['cookies'] });

    if (updateDownloaded) {
      console.log('🔄 Update pending — installing at session end');
      autoUpdater.quitAndInstall(false, true);
    } else {
      createLoginWindow();
    }

  } catch (err) {
    console.error('Failed to stop session or clear session:', err);
  }
});

ipcMain.on('start-bypass', async (_event, { token }) => {
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
  app.on('second-instance', () => {
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
    powerSaveBlocker.start('prevent-display-sleep');

    if (process.platform === 'darwin') {
      app.dock.hide();
    }
    Menu.setApplicationMenu(null);
    const instUuid = loadInstrumentUuid();
    if (instUuid) {
      await cleanupPreviousSession(instUuid);
    }

    createLoginWindow();

    // Schedule auto-update checks (only if updater token is configured)
    if (updaterToken) {
      setTimeout(() => {
        autoUpdater.checkForUpdates().catch(err => {
          console.error('Update check failed:', err?.message ?? err);
        });

        setInterval(() => {
          autoUpdater.checkForUpdates().catch(err => {
            console.error('Update check failed:', err?.message ?? err);
          });
        }, 4 * 60 * 60 * 1000); // every 4 hours
      }, 30_000); // 30s startup delay
    }

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

    // Windows: block system shortcuts that expose the taskbar/desktop/switcher
    if (!isMac) {
      // Win key (Start menu, Task View, Win+D, Win+M, etc.)
      if (input.meta) {
        event.preventDefault();
        console.log('🚫 Win key blocked — refocusing window');
        window.show();
        window.focus();
        window.moveTop();
        return;
      }
      // Alt+Tab (app switcher)
      if (input.alt && input.code === 'Tab') {
        event.preventDefault();
        console.log('🚫 Alt+Tab blocked — refocusing window');
        window.show();
        window.focus();
        window.moveTop();
        return;
      }
      // Ctrl+Esc (alternate Start menu shortcut)
      if (input.control && input.code === 'Escape') {
        event.preventDefault();
        console.log('🚫 Ctrl+Esc blocked');
        return;
      }
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
      session.defaultSession.clearStorageData({ storages: ['cookies'] }).then(() => {
        createBypassPanel(null);
      });
    }
  });
});
app.on('window-all-closed', () => {
  // Do nothing here to prevent app from quitting when all windows are closed
});
