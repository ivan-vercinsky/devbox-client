// Windows connection backend. FreeRDP is not a realistic option there, so we
// use Microsoft's own clients instead:
//  - msrdc.exe (Remote Desktop client / AVD client): takes our downloaded and
//    session-adjusted .rdp file directly and does its own Entra auth.
//  - "Windows App" (Store app): no .rdp file interface, but registers the
//    ms-avd: URI scheme, which is exactly what a Dev Box rdpConnectionUrl is.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const settings = require('./settings');

function msrdcCandidates() {
  const configured = settings.load().msrdcPath;
  const under = (envVar, ...parts) => (process.env[envVar] ? [path.join(process.env[envVar], ...parts)] : []);
  return [
    ...(configured ? [configured] : []),
    ...under('ProgramFiles', 'Remote Desktop', 'msrdc.exe'),
    ...under('ProgramFiles(x86)', 'Remote Desktop', 'msrdc.exe'),
    ...under('LOCALAPPDATA', 'Apps', 'Remote Desktop', 'msrdc.exe'), // per-user install
  ];
}

const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};

function hasAvdUriHandler() {
  try {
    execFileSync('reg.exe', ['query', 'HKCR\\ms-avd'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** { kind: 'msrdc', bin } | { kind: 'windows-app' } | null */
function findClient() {
  const bin = msrdcCandidates().find(exists);
  if (bin) return { kind: 'msrdc', bin };
  if (hasAvdUriHandler()) return { kind: 'windows-app' };
  return null;
}

const INSTALL_HINT =
  'No Remote Desktop client found. Install "Windows App" from the Microsoft Store, ' +
  'or the Remote Desktop client (msrdc) from https://aka.ms/AVDClient.';

module.exports = { findClient, INSTALL_HINT };
