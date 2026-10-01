const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Well-known Microsoft first-party public clients. We cannot register our own
// app in the tenant (no admin), so we borrow clients that are pre-consented:
//  - Azure CLI: pre-authorized for ARM + Dev Center data plane.
//  - Remote Desktop (MSRDC): used by FreeRDP for AVD / RDS AAD auth.
const DEFAULTS = {
  tenant: 'organizations',
  azureClientId: '04b07795-8ddb-461a-bbee-02f9e1bf7b46',
  azureRedirectUri: 'http://localhost',
  rdClientId: 'a85cf173-4192-42f8-81fa-777a763e6e2c',
  rdRedirectUri: 'ms-appx-web://Microsoft.AAD.BrokerPlugin/a85cf173-4192-42f8-81fa-777a763e6e2c',
  // Empty = discover via Azure Resource Graph. Comma separated otherwise.
  devCenterEndpoints: '',
  devCenterApiVersion: '2024-02-01',
  // Fallback only: the .rdp is normally fetched directly from
  // rdweb.wvd.microsoft.com/api/arm/feeddiscovery/tenants/{workspaceId}/rdps/{resourceId}.rdp
  feedUrls: [
    'https://rdweb.wvd.microsoft.com/api/arm/feeddiscovery/webfeed.aspx',
    'https://rdweb.wvd.microsoft.com/api/arm/feeddiscovery',
  ].join(','),
  freerdpPath: '',
  freerdpArgs: '/dynamic-resolution',
  // Windows only: explicit path to msrdc.exe (empty = look in the usual install locations).
  msrdcPath: '',
  // Per-connection device/feature redirection, shown in the "In Session Settings" dialog.
  sessionPrompt: true,
  // "<project>/<devbox>" -> features blocked by a policy on the Dev Box itself
  // (not visible in the .rdp, e.g. fDisableCdm), e.g. { "proj/box": ["drives"] }.
  policyBlocks: {},
  session: {
    clipboard: true,
    drives: 'home', // 'none' | 'home' | 'all'
    printer: false,
    microphone: true,
    camera: false,
    sound: true,
    location: false,
    smartcards: false,
    usbDevices: [], // 'vid:pid' of local USB devices to pass through
    keyboardShortcuts: true,
    fullscreen: false,
    multimon: false,
  },
};

const file = () => path.join(app.getPath('userData'), 'settings.json');

function load() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    /* defaults */
  }
  return { ...DEFAULTS, ...stored, session: { ...DEFAULTS.session, ...stored.session } };
}

// Only values that differ from DEFAULTS are persisted, so fixed defaults reach existing installs.
function save(values) {
  const merged = { ...load(), ...values };
  const differs = (k, v) => (typeof v === 'object' ? JSON.stringify(v) !== JSON.stringify(DEFAULTS[k]) : DEFAULTS[k] !== v);
  const overrides = Object.fromEntries(Object.entries(merged).filter(([k, v]) => differs(k, v)));
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(overrides, null, 2));
  return merged;
}

const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

module.exports = { DEFAULTS, load, save, list };
