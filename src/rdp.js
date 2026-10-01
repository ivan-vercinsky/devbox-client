// Launches FreeRDP 3 for a .rdp file and services its Entra ID token prompts.
//
// FreeRDP's CLI clients handle AVD (ARM gateway) and RDS AAD auth by printing
// "Browse to: https://login.microsoftonline.com/...authorize?..." and then
// reading the final redirect URL (ms-appx-web://...?code=...) from stdin.
// We open that URL in our own sign-in window (sharing Entra SSO cookies, so it
// usually completes invisibly) and feed the redirect back on stdin.
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const { dialog } = require('electron');
const settings = require('./settings');
const { captureRedirect } = require('./authwindow');
const usb = require('./usb');
const log = require('./log');

// On Wayland prefer the SDL client: xfreerdp runs under XWayland, where the
// clipboard hand-off between FreeRDP and the compositor is unreliable.
const CANDIDATES =
  process.env.XDG_SESSION_TYPE === 'wayland'
    ? ['sdl-freerdp3', 'xfreerdp3', 'sdl-freerdp', 'xfreerdp']
    : ['xfreerdp3', 'sdl-freerdp3', 'xfreerdp', 'sdl-freerdp'];

function versionOf(bin) {
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    return out.match(/version\s+(\d+)\.(\d+)\.(\d+)/i)?.slice(1).map(Number) || null;
  } catch {
    return null;
  }
}

function findFreeRdp() {
  const configured = settings.load().freerdpPath;
  for (const bin of configured ? [configured] : CANDIDATES) {
    const v = versionOf(bin);
    if (v && v[0] >= 3) return { bin, version: v.join('.') };
    if (v) log.warn(`rdp: ${bin} is FreeRDP ${v.join('.')}, need 3.x for Dev Box (AVD gateway + Entra auth)`);
  }
  return null;
}

// Split the args setting like a shell would for simple quoting.
function splitArgs(s) {
  return (s.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((a) => a.replace(/^(["'])(.*)\1$/, '$2'));
}

function readRdpProps(text) {
  const props = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([^:]+):([is]):(.*)$/);
    if (m) props[m[1].toLowerCase()] = m[2] === 'i' ? Number(m[3]) : m[3];
  }
  return props;
}

// Which session features the host pool's RDP properties allow. A missing key
// means the client default applies, so it counts as allowed.
function rdpCapabilities(text) {
  const p = readRdpProps(text);
  const on = (k, off = 0) => p[k] === undefined || p[k] !== off;
  const list = (k) => p[k] === undefined || String(p[k]).trim() !== '';
  return {
    clipboard: on('redirectclipboard'),
    printer: on('redirectprinters'),
    smartcards: on('redirectsmartcards'),
    location: on('redirectlocation'),
    microphone: on('audiocapturemode'),
    sound: on('audiomode', 2),
    camera: list('camerastoredirect'),
    usb: list('usbdevicestoredirect') || list('devicestoredirect'),
    drives: list('drivestoredirect'),
    multimon: on('use multimon'),
    keyboardShortcuts: true,
    fullscreen: true,
  };
}

/** Session options with anything the host pool or a known policy disallows switched off. */
function effectiveSession(options, caps, blocked = []) {
  const out = { ...options };
  for (const [k, allowed] of Object.entries(caps)) {
    if (allowed && !blocked.includes(k)) continue;
    if (k === 'drives') out.drives = 'none';
    else if (k === 'usb') out.usbDevices = [];
    else out[k] = false;
  }
  // Only devices that are plugged in and that FreeRDP can claim.
  const usable = new Set(usb.listDevices().filter((d) => d.writable).map((d) => d.id));
  out.usbDevices = (out.usbDevices || []).filter((id) => usable.has(id));
  return out;
}

// Rewrite redirection keys in the downloaded .rdp to match the session options.
function applySessionToRdp(text, o) {
  const set = {
    'redirectclipboard:i': o.clipboard ? 1 : 0,
    'redirectprinters:i': o.printer ? 1 : 0,
    'redirectsmartcards:i': o.smartcards ? 1 : 0,
    'redirectlocation:i': o.location ? 1 : 0,
    'redirectcomports:i': 0,
    'drivestoredirect:s': o.drives === 'all' ? '*' : '',
    'devicestoredirect:s': '',
    'usbdevicestoredirect:s': o.usbDevices.length ? '*' : '',
    'camerastoredirect:s': o.camera ? '*' : '',
    'audiocapturemode:i': o.microphone ? 1 : 0,
    'audiomode:i': o.sound ? 0 : 2,
    'use multimon:i': o.multimon ? 1 : 0,
  };
  const lines = text.split(/\r?\n/).filter((l) => {
    const k = l.split(':').slice(0, 2).join(':').toLowerCase();
    return !(k in set);
  });
  for (const [k, v] of Object.entries(set)) lines.push(`${k}:${v}`);
  return lines.join('\n');
}

function sessionArgs(o) {
  return [
    o.clipboard ? '+clipboard' : '-clipboard',
    // drivestoredirect:* only covers mount points (media, gvfs), so add the home folder explicitly.
    ...(o.drives === 'home' || o.drives === 'all' ? ['+home-drive'] : []),
    ...(o.sound ? ['/sound'] : []),
    ...(o.microphone ? ['/microphone'] : []),
    ...(o.multimon ? ['/multimon'] : []),
    ...(o.usbDevices.length ? [`/usb:id:${o.usbDevices.join('#')}`] : []),
    ...(o.fullscreen ? ['/f'] : []),
    o.keyboardShortcuts ? '+grab-keyboard' : '-grab-keyboard',
  ];
}

const sessions = new Map(); // key -> child
const events = new EventEmitter();

function connect(key, rdpFile, { parent, title, blocked = [] } = {}) {
  if (sessions.has(key)) throw new Error('Already connected');
  const found = findFreeRdp();
  if (!found) throw new Error('FreeRDP 3 not found. Install it with: sudo apt install freerdp3-sdl');

  const s = settings.load();
  const original = fs.readFileSync(rdpFile, 'utf8');
  const session = effectiveSession(s.session, rdpCapabilities(original), blocked);
  fs.writeFileSync(rdpFile, applySessionToRdp(original, session), { mode: 0o600 });
  log.info(`rdp: session options ${JSON.stringify(session)}`);
  const args = [
    rdpFile,
    // Floating toolbar (minimize / restore / close) whenever the session is full screen;
    // Ctrl+Alt+Enter toggles full screen.
    '/floatbar:sticky:off,default:visible,show:fullscreen',
    // Surface clipboard, drive and USB redirection activity in Diagnostics.
    '/log-filters:com.freerdp.channels.cliprdr.client:DEBUG,com.freerdp.channels.rdpdr.client:DEBUG,com.freerdp.channels.drive.client:DEBUG,com.freerdp.channels.urbdrc.client:DEBUG,com.freerdp.channels.drdynvc.client:DEBUG',
    ...sessionArgs(session),
    ...splitArgs(s.freerdpArgs || ''),
  ];
  if (title) args.push(`/title:${title}`);
  log.info(`rdp: ${found.bin} (${found.version}) ${args.join(' ')}`);

  // FreeRDP prints its auth prompt with printf; force line buffering so we see
  // it through the pipe instead of waiting for a 4 KiB buffer to fill.
  // DEVBOX_WLOG_LEVEL=DEBUG|TRACE raises FreeRDP's global log level for troubleshooting.
  const env = process.env.DEVBOX_WLOG_LEVEL ? { ...process.env, WLOG_LEVEL: process.env.DEVBOX_WLOG_LEVEL } : process.env;
  const child = spawn('stdbuf', ['-oL', '-eL', found.bin, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env });
  sessions.set(key, child);
  events.emit('state', key, 'connecting');

  // Prompts are answered one at a time, in the order FreeRDP asks them.
  let promptChain = Promise.resolve();
  const answer = (fn) => {
    promptChain = promptChain.then(async () => {
      try {
        const reply = await fn();
        if (!child.killed && child.stdin.writable) child.stdin.write(reply + '\n');
      } catch (e) {
        log.error('rdp:', e.message);
        child.kill();
      }
    });
  };

  const cert = {};
  const handleLine = (line) => {
    if (!line.trim()) return;
    log.debug(`freerdp: ${line}`);
    const field = line.match(/^\s*(Common Name|Thumbprint|Issuer):\s*(.*)$/);
    if (field) cert[field[1]] = field[2];

    const m = line.match(/(https:\/\/login\.microsoftonline\.com\/\S+)/);
    if (m) {
      const url = m[1];
      const redirectUri = new URL(url).searchParams.get('redirect_uri') || settings.load().rdRedirectUri;
      answer(async () => {
        const redirect = await captureRedirect(url, redirectUri, { parent, title: 'Sign in to Dev Box' });
        log.info('rdp: supplied Entra authorization to FreeRDP');
        return redirect;
      });
    }
    if (/Do you trust the above certificate\?/i.test(line)) {
      const info = { ...cert };
      answer(async () => {
        const { response } = await dialog.showMessageBox(parent, {
          type: 'question',
          title: 'Dev Box certificate',
          message: `Trust the certificate presented by ${info['Common Name'] || 'the Dev Box'}?`,
          detail:
            `Thumbprint: ${info.Thumbprint || 'unknown'}\nIssuer: ${info.Issuer || 'unknown'}\n\n` +
            'Dev Boxes use a self-signed certificate; the connection itself runs through the ' +
            "Microsoft-authenticated Azure Virtual Desktop gateway. FreeRDP's known-hosts entry " +
            'is checked on later connections when you choose "Always trust".',
          buttons: ['Always trust', 'Trust this time', 'Cancel'],
          defaultId: 0,
          cancelId: 2,
        });
        log.info(`rdp: certificate ${['trusted permanently', 'trusted once', 'rejected'][response]}`);
        return ['Y', 'T', 'N'][response];
      });
    }
    if (/connected to|Loaded \w+ channel|rdpgfx|RDPGFX/i.test(line)) events.emit('state', key, 'connected');
  };

  // Prompts printed without a trailing newline; flushed from the pending buffer.
  const PENDING_PROMPT = /(https:\/\/login\.microsoftonline\.com\/\S+\s|Do you trust the above certificate\?.*$)/i;

  for (const stream of [child.stdout, child.stderr]) {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      lines.forEach(handleLine);
      if (PENDING_PROMPT.test(buf)) {
        handleLine(buf);
        buf = '';
      }
    });
    stream.on('end', () => buf && handleLine(buf));
  }

  child.on('error', (e) => log.error('rdp: spawn failed', e.message));
  child.on('exit', (code, signal) => {
    sessions.delete(key);
    log.info(`rdp: session ${key} exited (code=${code}${signal ? `, signal=${signal}` : ''})`);
    events.emit('state', key, 'disconnected', code);
  });
}

function disconnect(key) {
  sessions.get(key)?.kill('SIGTERM');
}

function disconnectAll() {
  for (const c of sessions.values()) c.kill('SIGTERM');
}

module.exports = { connect, disconnect, disconnectAll, findFreeRdp, events, isConnected: (k) => sessions.has(k), applySessionToRdp, sessionArgs, rdpCapabilities };
