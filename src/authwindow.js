const { BrowserWindow, session } = require('electron');
const log = require('./log');

// All sign-in windows share one persistent cookie jar, so after the first
// interactive login, later flows (other clients, FreeRDP prompts) complete
// silently via Entra SSO cookies.
const PARTITION = 'persist:entra';

const authSession = () => session.fromPartition(PARTITION);

/**
 * Open `authorizeUrl` and resolve with the full redirect URL once Entra
 * redirects to something starting with `redirectUri`. The window stays hidden
 * unless the user actually needs to interact (SSO usually finishes on its own).
 */
function captureRedirect(authorizeUrl, redirectUri, { parent, title = 'Sign in', revealAfterMs = 1500 } = {}) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 520,
      height: 720,
      show: false,
      parent,
      modal: !!parent,
      title,
      autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });

    let done = false;
    const prefix = redirectUri.toLowerCase();
    const finish = (err, url) => {
      if (done) return;
      done = true;
      clearTimeout(revealTimer);
      if (!win.isDestroyed()) win.destroy();
      err ? reject(err) : resolve(url);
    };

    const check = (event, url) => {
      if (!url || !url.toLowerCase().startsWith(prefix)) return;
      if (event && event.preventDefault) event.preventDefault();
      const params = new URL(url.replace(/#/, '?')).searchParams;
      if (params.get('error')) {
        finish(new Error(`${params.get('error')}: ${params.get('error_description') || ''}`.trim()));
      } else {
        finish(null, url);
      }
    };

    win.webContents.on('will-redirect', check);
    win.webContents.on('will-navigate', check);
    win.webContents.on('did-start-navigation', (e) => check(null, e.url));
    win.webContents.on('did-fail-load', (_e, _code, _desc, url) => check(null, url));
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    const revealTimer = setTimeout(() => {
      if (!done && !win.isDestroyed()) win.show();
    }, revealAfterMs);

    win.on('closed', () => finish(new Error('Sign-in window was closed')));

    log.debug('auth: opening', authorizeUrl.split('?')[0]);
    win.loadURL(authorizeUrl).catch((e) => {
      // Loading fails when the final hop is our custom redirect scheme; that's expected.
      if (!done) log.debug('auth: loadURL', e.message);
    });
  });
}

async function clearSession() {
  await authSession().clearStorageData();
}

module.exports = { captureRedirect, clearSession, PARTITION };
