const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const auth = require('./auth');
const devcenter = require('./devcenter');
const avd = require('./avd');
const rdp = require('./rdp');
const webclient = require('./webclient');
const usb = require('./usb');
const settings = require('./settings');
const log = require('./log');

let win;

const keyOf = (box) => `${box.projectName}/${box.name}`;

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

// Wrap handlers so the renderer gets clean { ok, data | error } results.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      log.error(`${channel}:`, e.message);
      return { ok: false, error: e.message };
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 560,
    height: 720,
    minWidth: 420,
    minHeight: 480,
    title: 'Dev Box',
    autoHideMenuBar: true,
    backgroundColor: '#1b1b1f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

handle('app:init', async () => {
  const freerdp = rdp.findFreeRdp();
  if (freerdp) log.info(`rdp: using ${freerdp.bin} ${freerdp.version}`);
  else log.warn('rdp: FreeRDP 3 not found (sudo apt install freerdp3-x11)');
  return { account: await auth.currentAccount(), freerdp };
});

handle('auth:signIn', () => auth.signIn(win));
handle('auth:signOut', async () => {
  rdp.disconnectAll();
  await auth.signOut();
});

handle('devbox:list', async () => {
  const boxes = await devcenter.listDevBoxes({ parent: win });
  return boxes.map((b) => ({ ...b, session: rdp.isConnected(keyOf(b)) ? 'connected' : null }));
});

handle('devbox:action', (box, verb) => {
  if (!['start', 'stop', 'hibernate', 'restart'].includes(verb)) throw new Error(`Unknown action ${verb}`);
  return devcenter.action(box, verb, { parent: win });
});

async function downloadRdp(box) {
  const conn = await devcenter.remoteConnection(box, { parent: win });
  log.debug('devbox: remoteConnection', conn);
  return avd.getRdpFile(box, conn, { parent: win });
}

const policyBlocks = (box) => settings.load().policyBlocks[keyOf(box)] || [];

// What the session dialog may offer: host pool RDP properties + known Dev Box policy blocks.
handle('devbox:capabilities', async (box) => {
  const file = await downloadRdp(box);
  return { caps: rdp.rdpCapabilities(fs.readFileSync(file, 'utf8')), blocked: policyBlocks(box) };
});

handle('devbox:setPolicyBlock', (box, feature, isBlocked) => {
  const all = settings.load().policyBlocks;
  const list = new Set(all[keyOf(box)] || []);
  isBlocked ? list.add(feature) : list.delete(feature);
  settings.save({ policyBlocks: { ...all, [keyOf(box)]: [...list] } });
});

handle('devbox:connect', async (box) => {
  const key = keyOf(box);
  rdp.events.emit('state', key, 'preparing');
  try {
    const file = await downloadRdp(box);
    rdp.connect(key, file, { parent: win, title: `Dev Box – ${box.name}`, blocked: policyBlocks(box) });
  } catch (e) {
    rdp.events.emit('state', key, 'disconnected');
    throw e;
  }
});

handle('usb:list', () => usb.listDevices());
handle('usb:udevCommand', (ids) => usb.udevCommand(ids));

handle('devbox:disconnect', (box) => rdp.disconnect(keyOf(box)));

handle('devbox:openWeb', async (box, external = false) => {
  const conn = await devcenter.remoteConnection(box, { parent: win });
  if (!conn?.webUrl) throw new Error('No web URL returned for this Dev Box');
  if (external) await shell.openExternal(conn.webUrl);
  else webclient.open(keyOf(box), conn.webUrl, `Dev Box – ${box.name} (web)`);
});

handle('settings:get', () => ({ values: settings.load(), defaults: settings.DEFAULTS }));
handle('settings:save', (values) => settings.save(values));
handle('log:history', () => log.history());

log.subscribe((entry) => send('log:entry', entry));
rdp.events.on('state', (key, state, code) => send('rdp:state', { key, state, code }));

app.setName('Dev Box');
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => rdp.disconnectAll());
