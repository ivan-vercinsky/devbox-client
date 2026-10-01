// In-app Windows 365 web client: a fallback when FreeRDP can't connect.
// Shares the Entra cookie jar with the sign-in windows, so it normally opens
// without another login.
const { BrowserWindow, session, shell } = require('electron');
const { PARTITION } = require('./authwindow');
const log = require('./log');

const windows = new Map(); // key -> BrowserWindow

const MICROSOFT_HOST = /(^|\.)(microsoft\.com|cloud\.microsoft|microsoftonline\.com|live\.com|msauth\.net|msftauth\.net)$/i;
const isMicrosoft = (url) => {
  try {
    return MICROSOFT_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

// Clipboard, mic/camera, full screen etc. are needed by the web client; only
// granted to Microsoft origins.
const ALLOWED = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'media', 'notifications', 'pointerLock', 'keyboardLock']);
let permissionsSet = false;
function setupPermissions() {
  if (permissionsSet) return;
  permissionsSet = true;
  const ses = session.fromPartition(PARTITION);
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(ALLOWED.has(permission) && isMicrosoft(details.requestingUrl || wc.getURL()));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => ALLOWED.has(permission) && isMicrosoft(origin));
}

function open(key, url, title) {
  const existing = windows.get(key);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return;
  }
  setupPermissions();
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  windows.set(key, win);
  win.on('closed', () => windows.delete(key));
  win.on('page-title-updated', (e) => e.preventDefault());

  // Sign-in popups stay in-app; anything else goes to the system browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isMicrosoft(target)) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } };
    shell.openExternal(target);
    return { action: 'deny' };
  });

  // F11 toggles full screen (the web client also has its own full-screen button).
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      e.preventDefault();
    }
  });

  log.info(`web: opening ${url}`);
  win.loadURL(url);
}

module.exports = { open };
