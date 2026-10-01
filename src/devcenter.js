const auth = require('./auth');
const settings = require('./settings');
const log = require('./log');

async function http(method, url, token, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not json */
  }
  if (!res.ok) {
    const msg = json?.error?.message || text || res.statusText;
    const err = new Error(`${method} ${url.split('?')[0]} -> ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return { json, headers: res.headers, status: res.status };
}

async function getAll(url, token) {
  const out = [];
  while (url) {
    const { json } = await http('GET', url, token);
    out.push(...(json?.value || []));
    url = json?.nextLink;
  }
  return out;
}

let discovered = null;

/** Find Dev Center data-plane endpoints, via settings or Azure Resource Graph. */
async function endpoints({ parent, refresh = false } = {}) {
  const manual = settings.list(settings.load().devCenterEndpoints);
  if (manual.length) return manual.map((e) => e.replace(/\/+$/, ''));
  if (discovered && !refresh) return discovered;

  const token = await auth.getToken('arm', { parent });
  const query = "Resources | where type =~ 'microsoft.devcenter/projects' | project name, devCenterUri = tostring(properties.devCenterUri)";
  const { json } = await http(
    'POST',
    'https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01',
    token,
    { query, options: { resultFormat: 'objectArray' } },
  );
  const rows = json?.data || [];
  log.info(`devcenter: resource graph found ${rows.length} project(s)`);
  discovered = [...new Set(rows.map((r) => r.devCenterUri).filter(Boolean).map((u) => u.replace(/\/+$/, '')))];
  if (!discovered.length) {
    throw new Error(
      'No Dev Center projects visible via Azure Resource Graph. Open Settings and enter your Dev Center endpoint ' +
        '(from devportal.microsoft.com → browser devtools, e.g. https://<tenant>-<devcenter>.<region>.devcenter.azure.com).',
    );
  }
  return discovered;
}

const api = () => settings.load().devCenterApiVersion;
const boxPath = (b) => `/projects/${encodeURIComponent(b.projectName)}/users/me/devboxes/${encodeURIComponent(b.name)}`;

async function listForEndpoint(ep, token) {
  try {
    return await getAll(`${ep}/users/me/devboxes?api-version=${api()}`, token);
  } catch (e) {
    // Fallback: enumerate projects, then dev boxes per project.
    log.warn(`devcenter: user-wide list failed on ${ep}, falling back per project: ${e.message}`);
    const projects = await getAll(`${ep}/projects?api-version=${api()}`, token);
    const all = [];
    for (const p of projects) {
      const boxes = await getAll(`${ep}/projects/${encodeURIComponent(p.name)}/users/me/devboxes?api-version=${api()}`, token);
      all.push(...boxes.map((b) => ({ projectName: p.name, ...b })));
    }
    return all;
  }
}

async function listDevBoxes({ parent } = {}) {
  const eps = await endpoints({ parent });
  const token = await auth.getToken('devcenter', { parent });
  const result = [];
  for (const ep of eps) {
    const boxes = await listForEndpoint(ep, token);
    result.push(...boxes.map((b) => ({ ...b, endpoint: ep })));
  }
  log.info(`devcenter: ${result.length} dev box(es)`);
  return result.map(normalize);
}

function normalize(b) {
  return {
    name: b.name,
    projectName: b.projectName,
    poolName: b.poolName,
    endpoint: b.endpoint,
    powerState: b.powerState || 'Unknown',
    provisioningState: b.provisioningState,
    actionState: b.actionState,
    location: b.location,
    osType: b.osType,
    hibernateSupport: b.hibernateSupport,
    sku: b.hardwareProfile?.skuName,
    vcpus: b.hardwareProfile?.vCPUs,
    memoryGB: b.hardwareProfile?.memoryGB,
    storageGB: b.storageProfile?.osDisk?.diskSizeGB,
    error: b.error?.message,
  };
}

async function action(box, verb, { parent } = {}) {
  const token = await auth.getToken('devcenter', { parent });
  const op = verb === 'hibernate' ? 'stop' : verb;
  const extra = verb === 'hibernate' ? '&hibernate=true' : '';
  const url = `${box.endpoint}${boxPath(box)}:${op}?api-version=${api()}${extra}`;
  log.info(`devcenter: ${verb} ${box.projectName}/${box.name}`);
  await http('POST', url, token);
}

async function remoteConnection(box, { parent } = {}) {
  const token = await auth.getToken('devcenter', { parent });
  const { json } = await http('GET', `${box.endpoint}${boxPath(box)}/remoteConnection?api-version=${api()}`, token);
  return json; // { webUrl, rdpConnectionUrl }
}

module.exports = { listDevBoxes, action, remoteConnection, endpoints };
