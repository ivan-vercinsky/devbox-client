const api = window.devbox;
const $ = (id) => document.getElementById(id);

const state = {
  account: null,
  boxes: [],
  sessions: {}, // key -> 'preparing' | 'connecting' | 'connected'
  pending: {}, // key -> { verb, expect: [powerStates], until, connectAfter }
  loading: false,
};

const keyOf = (b) => `${b.projectName}/${b.name}`;
const EXPECT = {
  start: ['Running'],
  stop: ['Deallocated', 'PoweredOff'],
  hibernate: ['Hibernated'],
  restart: null, // no visible end state; just wait a bit
};
const STOPPED = ['Deallocated', 'PoweredOff', 'Hibernated'];

// ---------- rendering ----------

function statusOf(box) {
  const key = keyOf(box);
  const s = state.sessions[key];
  if (s === 'preparing') return ['warn', 'Preparing connection…'];
  if (s === 'connecting') return ['warn', 'Connecting…'];
  if (s === 'connected') return ['ok', 'Connected'];
  const p = state.pending[key];
  if (p) return ['warn', { start: 'Starting…', stop: 'Shutting down…', hibernate: 'Hibernating…', restart: 'Restarting…' }[p.verb]];
  if (box.provisioningState && !/succeeded/i.test(box.provisioningState)) {
    return [/fail/i.test(box.provisioningState) ? 'err' : 'warn', box.provisioningState];
  }
  if (box.powerState === 'Running') return ['ok', 'Running'];
  if (box.powerState === 'Hibernated') return ['off', 'Hibernated'];
  if (STOPPED.includes(box.powerState)) return ['off', 'Stopped'];
  return ['off', box.powerState || 'Unknown'];
}

function renderBox(box) {
  const key = keyOf(box);
  const el = $('box-template').content.firstElementChild.cloneNode(true);
  const [tone, text] = statusOf(box);
  const busy = !!state.pending[key] || ['preparing', 'connecting'].includes(state.sessions[key]);
  const connected = state.sessions[key] === 'connected' || state.sessions[key] === 'connecting';

  el.querySelector('.box-name').textContent = box.name;
  el.querySelector('.box-meta').textContent = [box.projectName, box.poolName].filter(Boolean).join(' · ');
  el.querySelector('.dot').className = `dot ${tone}`;
  el.querySelector('.status-text').textContent = text;
  el.querySelector('.box-specs').textContent = [
    box.vcpus && `${box.vcpus} vCPU`,
    box.memoryGB && `${box.memoryGB} GB RAM`,
    box.storageGB && `${box.storageGB} GB disk`,
    box.location,
  ].filter(Boolean).join(' · ');
  if (box.error) {
    const err = el.querySelector('.box-error');
    err.textContent = box.error;
    err.hidden = false;
  }

  const main = el.querySelector('.act-main');
  if (connected) {
    main.textContent = 'Disconnect';
    main.classList.remove('primary');
    main.onclick = () => run(() => api.disconnect(box));
  } else {
    main.textContent = box.powerState === 'Running' ? 'Connect' : 'Start & connect';
    main.disabled = busy;
    main.onclick = () => connect(box);
  }

  const web = el.querySelector('.act-web');
  web.disabled = box.powerState !== 'Running' || !!state.pending[key];
  web.onclick = () => run(() => api.openWeb(box));

  const items = el.querySelector('.menu-items');
  const running = box.powerState === 'Running';
  const enable = {
    start: !running && !busy,
    restart: running && !busy,
    hibernate: running && !busy && box.hibernateSupport === 'Enabled',
    stop: running && !busy,
    session: true,
    web: true,
    browser: true,
  };
  for (const b of items.querySelectorAll('button')) {
    const verb = b.dataset.verb;
    b.disabled = !enable[verb];
    if (verb === 'hibernate' && box.hibernateSupport !== 'Enabled') b.hidden = true;
    b.onclick = () => {
      items.hidden = true;
      if (verb === 'session') run(async () => sessionDialog((await api.getSettings()).values, 'edit', box));
      else if (verb === 'web' || verb === 'browser') run(() => api.openWeb(box, verb === 'browser'));
      else doAction(box, verb);
    };
  }
  el.querySelector('.act-more').onclick = (e) => {
    e.stopPropagation();
    document.querySelectorAll('.menu-items').forEach((m) => m !== items && (m.hidden = true));
    items.hidden = !items.hidden;
  };
  return el;
}

function render() {
  $('signed-out').hidden = !!state.account;
  $('signed-in').hidden = !state.account;
  $('refresh').hidden = !state.account;
  $('sign-out').hidden = !state.account;
  $('account').textContent = state.account ? `${state.account.name || ''} ${state.account.username}`.trim() : '';
  $('loading').hidden = !(state.loading && !state.boxes.length);
  $('empty').hidden = state.loading || state.boxes.length > 0 || !$('banner').hidden;
  $('boxes').replaceChildren(...state.boxes.map(renderBox));
}

function showError(msg) {
  const b = $('banner');
  b.textContent = msg || '';
  b.hidden = !msg;
}

async function run(fn) {
  try {
    showError(null);
    return await fn();
  } catch (e) {
    showError(e.message);
    render();
  }
}

// ---------- behaviour ----------

async function refresh() {
  if (!state.account) return;
  state.loading = true;
  render();
  await run(async () => {
    state.boxes = await api.list();
    for (const b of state.boxes) if (b.session) state.sessions[keyOf(b)] ||= b.session;
    settlePending();
  });
  state.loading = false;
  render();
  schedule();
}

function settlePending() {
  const now = Date.now();
  for (const box of state.boxes) {
    const key = keyOf(box);
    const p = state.pending[key];
    if (!p) continue;
    const reached = p.expect ? p.expect.includes(box.powerState) : now > p.until;
    if (reached || now > p.deadline) {
      delete state.pending[key];
      if (p.connectAfter && box.powerState === 'Running') connect(box, { skipPrompt: true });
    }
  }
}

let timer;
function schedule() {
  clearTimeout(timer);
  const fast = Object.keys(state.pending).length > 0;
  timer = setTimeout(refresh, fast ? 10_000 : 60_000);
}

async function doAction(box, verb, { connectAfter = false } = {}) {
  const key = keyOf(box);
  const now = Date.now();
  state.pending[key] = { verb, expect: EXPECT[verb], until: now + 45_000, deadline: now + 15 * 60_000, connectAfter };
  render();
  const ok = await run(async () => {
    await api.action(box, verb);
    return true;
  });
  if (!ok) delete state.pending[key];
  render();
  schedule();
}

async function connect(box, { skipPrompt = false } = {}) {
  if (!skipPrompt) {
    const { values } = await api.getSettings();
    if (values.sessionPrompt && !(await sessionDialog(values, 'connect', box))) return;
  }
  if (box.powerState !== 'Running') return doAction(box, 'start', { connectAfter: true });
  state.sessions[keyOf(box)] = 'preparing';
  render();
  run(() => api.connect(box));
}

api.onRdpState(({ key, state: s }) => {
  if (s === 'disconnected') delete state.sessions[key];
  else state.sessions[key] = s;
  render();
});

// ---------- diagnostics ----------

function appendLog(entry) {
  const line = document.createElement('div');
  line.className = entry.level;
  line.textContent = `${entry.t.slice(11, 19)} ${entry.level.padEnd(5)} ${entry.msg}`;
  const log = $('log');
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
  log.appendChild(line);
  while (log.childElementCount > 1000) log.firstChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
}
api.onLog(appendLog);
$('toggle-log').onclick = () => {
  $('log-panel').hidden = !$('log-panel').hidden;
  $('log').scrollTop = $('log').scrollHeight;
};
$('close-log').onclick = () => ($('log-panel').hidden = true);
$('copy-log').onclick = () => navigator.clipboard.writeText($('log').innerText);

// ---------- session settings ----------

/** Show the In Session Settings dialog; resolves true if the user confirmed (and saves the choices). */
function sessionDialog(values, mode, box) {
  const dlg = $('session-dialog');
  const form = $('session-form');
  const fields = [...form.elements].filter((el) => el.name && el.name !== 'dontShow');
  for (const el of fields) {
    el.disabled = true;
    if (el.type === 'checkbox') el.checked = !!values.session[el.name];
    else el.value = values.session[el.name];
    el.closest('label, .row').querySelector('.na')?.remove();
  }
  form.elements.dontShow.checked = !values.sessionPrompt;
  $('session-go').textContent = mode === 'connect' ? 'Connect' : 'Save';
  $('session-status').textContent = 'Checking what your organization allows…';
  const usb = usbPicker(values.session.usbDevices || []);
  dlg.showModal();

  // Gray out what the host pool's RDP properties or a known Dev Box policy disallow.
  api
    .capabilities(box)
    .then(({ caps, blocked }) => {
      if (caps.usb === false) usb.disable('not allowed by your organization');
      else if (blocked.includes('usb')) usb.disable('blocked by Dev Box policy');
      for (const el of fields) {
        const byPool = caps[el.name] === false;
        const byPolicy = blocked.includes(el.name);
        el.disabled = byPool || byPolicy;
        if (!el.disabled) continue;
        if (el.type === 'checkbox') el.checked = false;
        else el.value = 'none';
        const note = document.createElement('small');
        note.className = 'na';
        note.textContent = byPool ? 'not allowed by your organization' : 'blocked by Dev Box policy · ';
        if (byPolicy) {
          const retry = document.createElement('a');
          retry.href = '#';
          retry.textContent = 'try again';
          retry.onclick = async (e) => {
            e.preventDefault();
            await api.setPolicyBlock(box, el.name, false);
            el.disabled = false;
            note.remove();
          };
          note.appendChild(retry);
        }
        (el.closest('.row')?.querySelector('span') || el.closest('label')).appendChild(note);
      }
      $('session-status').textContent = '';
    })
    .catch((e) => {
      for (const el of fields) el.disabled = false;
      $('session-status').textContent = `Couldn't check availability (${e.message}).`;
    });

  return new Promise((resolve) => {
    dlg.addEventListener(
      'close',
      async () => {
        if (dlg.returnValue !== 'go') return resolve(false);
        // Disabled (unavailable) options keep the user's previous preference.
        const session = { ...values.session, usbDevices: usb.selected() };
        for (const el of fields) {
          if (!el.disabled) session[el.name] = el.type === 'checkbox' ? el.checked : el.value;
        }
        await api.saveSettings({ session, sessionPrompt: !form.elements.dontShow.checked });
        resolve(true);
      },
      { once: true },
    );
  });
}

/** USB device list in the session dialog. Selections of unplugged devices are kept. */
function usbPicker(initial) {
  const chosen = new Set(initial);
  let disabledReason = null;
  let devices = [];

  const showFix = (ids) =>
    api.usbUdevCommand(ids).then((cmd) => {
      $('usb-cmd').textContent = cmd;
      $('usb-fix').hidden = false;
    });

  function render() {
    const list = $('usb-list');
    list.replaceChildren();
    if (disabledReason) {
      list.textContent = `Unavailable: ${disabledReason}.`;
      return;
    }
    if (!devices.length) list.textContent = 'No USB devices found.';
    for (const d of devices) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = chosen.has(d.id);
      box.disabled = !d.writable;
      box.onchange = () => (box.checked ? chosen.add(d.id) : chosen.delete(d.id));
      const text = document.createElement('span');
      text.textContent = d.name + ' ';
      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = [d.kinds.join(', '), d.id].filter(Boolean).join(' · ');
      text.appendChild(kind);
      if (!d.writable) {
        const grant = document.createElement('a');
        grant.href = '#';
        grant.className = 'grant';
        grant.textContent = 'grant access';
        grant.onclick = (e) => {
          e.preventDefault();
          showFix([d.id]);
        };
        text.append(' · ', grant);
      }
      label.append(box, text);
      list.appendChild(label);
    }
  }

  const load = () =>
    api.usbDevices().then((d) => {
      devices = d;
      render();
    });

  $('usb-fix').hidden = true;
  $('usb-list').textContent = 'Looking for USB devices…';
  $('usb-copy').onclick = () => navigator.clipboard.writeText($('usb-cmd').textContent);
  $('usb-recheck').onclick = () => load().then(() => ($('usb-fix').hidden = true));
  load();

  return {
    disable(reason) {
      disabledReason = reason;
      render();
    },
    selected: () => [...chosen],
  };
}

// ---------- settings ----------

let defaults = {};
function fillSettings(values) {
  for (const input of $('settings-form').querySelectorAll('input')) {
    if (input.type === 'checkbox') input.checked = !!values[input.name];
    else input.value = values[input.name] ?? '';
  }
}
$('open-settings').onclick = async () => {
  const s = await api.getSettings();
  defaults = s.defaults;
  fillSettings(s.values);
  $('settings').showModal();
};
$('reset-settings').onclick = () => fillSettings(defaults);
$('settings').addEventListener('close', async () => {
  if ($('settings').returnValue !== 'save') return;
  const values = Object.fromEntries(
    [...$('settings-form').querySelectorAll('input')].map((i) => [i.name, i.type === 'checkbox' ? i.checked : i.value.trim()]),
  );
  await run(() => api.saveSettings(values));
  refresh();
});

// ---------- auth ----------

$('sign-in').onclick = () =>
  run(async () => {
    state.account = await api.signIn();
    render();
    refresh();
  });
$('sign-out').onclick = () =>
  run(async () => {
    await api.signOut();
    Object.assign(state, { account: null, boxes: [], sessions: {}, pending: {} });
    clearTimeout(timer);
    render();
  });
$('refresh').onclick = refresh;
document.addEventListener('click', () => document.querySelectorAll('.menu-items').forEach((m) => (m.hidden = true)));

// ---------- startup ----------

(async () => {
  for (const e of await api.logHistory()) appendLog(e);
  const info = await run(() => api.init());
  state.account = info?.account || null;
  render();
  if (!info?.freerdp) showError('FreeRDP 3 was not found. Install it with:  sudo apt install freerdp3-x11');
  if (state.account) refresh();
})();
