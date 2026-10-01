// Turns a Dev Box `rdpConnectionUrl` (ms-avd:connect?workspaceId=..&resourceid=..)
// into a real .rdp file by reading the user's Azure Virtual Desktop (ARM) feed,
// which is where Windows App itself gets Dev Box / Cloud PC connection files.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { XMLParser } = require('fast-xml-parser');
const auth = require('./auth');
const settings = require('./settings');
const log = require('./log');

function parseAvdUri(uri) {
  const out = {};
  if (!uri) return out;
  const q = uri.includes('?') ? uri.slice(uri.indexOf('?') + 1) : '';
  for (const [k, v] of new URLSearchParams(q)) out[k.toLowerCase()] = v;
  return out; // workspaceid, resourceid, username, ...
}

function* walk(node, key) {
  if (Array.isArray(node)) {
    for (const n of node) yield* walk(n, key);
  } else if (node && typeof node === 'object') {
    yield [key, node];
    for (const [k, v] of Object.entries(node)) yield* walk(v, k);
  }
}

/** Extract { id, title, alias, rdpUrl } from either the XML (MS-TSWP) or a JSON feed. */
function parseFeed(text) {
  const resources = [];
  const trimmed = text.trim();
  if (trimmed.startsWith('<')) {
    const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', removeNSPrefix: true }).parse(trimmed);
    for (const [key, node] of walk(doc)) {
      if (key !== 'Resource') continue;
      let rdpUrl = null;
      for (const [k, n] of walk(node)) {
        if (k === 'ResourceFile' && n.URL && (!n.FileExtension || n.FileExtension.toLowerCase() === '.rdp')) rdpUrl = rdpUrl || n.URL;
      }
      resources.push({ id: node.ID, title: node.Title, alias: node.Alias, rdpUrl });
    }
  } else if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    for (const [, node] of walk(JSON.parse(trimmed))) {
      const rdpUrl = Object.entries(node).find(([k, v]) => typeof v === 'string' && /rdp.*url|fileurl/i.test(k))?.[1];
      if (rdpUrl) resources.push({ id: node.id || node.resourceId, title: node.title || node.name || node.friendlyName, alias: node.alias, rdpUrl });
    }
  }
  return resources;
}

function decode(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
}

// rdweb rejects requests without this header (INCOMPATIBLE_CLIENT_VERSION); any value is accepted.
const CLIENT_UA = 'com.microsoft.rdc.windows.msrdc.x64/1.2.6353.0';

async function fetchText(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'X-MS-User-Agent': CLIENT_UA, Accept: 'application/xml, application/json, */*' },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { ok: res.ok, status: res.status, text: decode(buf) };
}

function pick(resources, ids, box) {
  const eq = (a, b) => a && b && String(a).toLowerCase() === String(b).toLowerCase();
  return (
    resources.find((r) => eq(r.id, ids.resourceid)) ||
    resources.find((r) => r.rdpUrl && ids.resourceid && r.rdpUrl.toLowerCase().includes(ids.resourceid.toLowerCase())) ||
    resources.find((r) => eq(r.title, box.name) || eq(r.alias, box.name)) ||
    (resources.length === 1 ? resources[0] : null)
  );
}

/** Returns the path of a .rdp file for `box`, using its remoteConnection info. */
async function getRdpFile(box, conn, { parent } = {}) {
  const ids = parseAvdUri(conn?.rdpConnectionUrl);
  log.info(`avd: workspace=${ids.workspaceid || '?'} resource=${ids.resourceid || '?'}`);
  const token = await auth.getToken('avd', { parent });

  // Direct URL, as used by the Windows 365 web client.
  if (ids.workspaceid && ids.resourceid) {
    const rdpUrl = `https://rdweb.wvd.microsoft.com/api/arm/feeddiscovery/tenants/${ids.workspaceid}/rdps/${ids.resourceid}.rdp`;
    const r = await fetchText(rdpUrl, token);
    if (r.ok && /full address|gatewayhostname|workspace id/i.test(r.text)) return writeRdp(box, r.text);
    log.warn(`avd: direct .rdp -> HTTP ${r.status}: ${r.text.slice(0, 300)}; trying feed`);
  }

  let chosen = null;
  for (const feedUrl of settings.list(settings.load().feedUrls)) {
    try {
      const r = await fetchText(feedUrl, token);
      if (!r.ok) {
        log.warn(`avd: feed ${feedUrl} -> HTTP ${r.status}: ${r.text.slice(0, 300)}`);
        continue;
      }
      const resources = parseFeed(r.text);
      log.info(`avd: feed ${feedUrl} -> ${resources.length} resource(s): ${resources.map((x) => x.title).join(', ')}`);
      if (!resources.length) log.debug(`avd: feed body starts: ${r.text.slice(0, 500)}`);
      chosen = pick(resources, ids, box);
      if (chosen?.rdpUrl) break;
    } catch (e) {
      log.warn(`avd: feed ${feedUrl} failed: ${e.message}`);
    }
  }
  if (!chosen?.rdpUrl) {
    throw new Error('Could not find this Dev Box in the Azure Virtual Desktop feed (see Diagnostics). Try "Open web client" (⋯ menu) instead.');
  }

  const rdp = await fetchText(chosen.rdpUrl, token);
  if (!rdp.ok) throw new Error(`Downloading .rdp failed: HTTP ${rdp.status}`);
  return writeRdp(box, rdp.text);
}

function writeRdp(box, text) {
  const dir = path.join(app.getPath('userData'), 'rdp');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${box.projectName}-${box.name}.rdp`.replace(/[^\w.-]/g, '_'));
  fs.writeFileSync(file, text, { mode: 0o600 });
  log.info(`avd: wrote ${file}`);
  log.debug('avd: rdp settings: ' + text.split(/\r?\n/).filter((l) => l && !/token|password/i.test(l)).join(' | '));
  return file;
}

module.exports = { getRdpFile, parseAvdUri, parseFeed };
