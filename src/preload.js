const { contextBridge, ipcRenderer } = require('electron');

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

contextBridge.exposeInMainWorld('devbox', {
  init: () => call('app:init'),
  signIn: () => call('auth:signIn'),
  signOut: () => call('auth:signOut'),
  list: () => call('devbox:list'),
  action: (box, verb) => call('devbox:action', box, verb),
  connect: (box) => call('devbox:connect', box),
  disconnect: (box) => call('devbox:disconnect', box),
  capabilities: (box) => call('devbox:capabilities', box),
  usbDevices: () => call('usb:list'),
  usbUdevCommand: (ids) => call('usb:udevCommand', ids),
  setPolicyBlock: (box, feature, blocked) => call('devbox:setPolicyBlock', box, feature, blocked),
  openWeb: (box, external = false) => call('devbox:openWeb', box, external),
  getSettings: () => call('settings:get'),
  saveSettings: (values) => call('settings:save', values),
  logHistory: () => call('log:history'),
  onLog: (fn) => ipcRenderer.on('log:entry', (_e, entry) => fn(entry)),
  onRdpState: (fn) => ipcRenderer.on('rdp:state', (_e, s) => fn(s)),
});
