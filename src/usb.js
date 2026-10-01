// Local USB devices for FreeRDP USB redirection (/usb:id:<vid>:<pid>).
// FreeRDP claims the device through /dev/bus/usb, so the user needs write
// access to its node; we offer a udev "uaccess" rule when that's missing.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SYS = '/sys/bus/usb/devices';

const read = (dir, file) => {
  try {
    return fs.readFileSync(path.join(dir, file), 'utf8').trim();
  } catch {
    return '';
  }
};

// Names from lsusb, for devices that don't report useful strings themselves.
function lsusbNames() {
  const names = {};
  try {
    for (const line of execFileSync('lsusb', { encoding: 'utf8', timeout: 3000 }).split('\n')) {
      const m = line.match(/ID ([0-9a-f]{4}:[0-9a-f]{4}) (.*)$/i);
      if (m && m[2].trim()) names[m[1].toLowerCase()] = m[2].trim();
    }
  } catch {
    /* lsusb missing */
  }
  return names;
}

const CLASS_LABEL = { '08': 'storage', '0b': 'smart card', '0e': 'camera', '03': 'input', '01': 'audio', e0: 'wireless' };

function listDevices() {
  let entries = [];
  try {
    entries = fs.readdirSync(SYS).filter((d) => /^\d+-[\d.]+$/.test(d)); // devices, not interfaces/hubs roots
  } catch {
    return [];
  }
  const names = lsusbNames();
  const devices = [];
  for (const d of entries) {
    const dir = path.join(SYS, d);
    if (read(dir, 'bDeviceClass') === '09') continue; // hubs
    const vid = read(dir, 'idVendor');
    const pid = read(dir, 'idProduct');
    if (!vid || !pid) continue;
    const id = `${vid}:${pid}`.toLowerCase();
    const ifClasses = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(`${d}:`))
      .map((f) => read(path.join(dir, f), 'bInterfaceClass').toLowerCase());
    const product = [read(dir, 'manufacturer'), read(dir, 'product')].filter((s) => s && !/string$/i.test(s)).join(' ');
    const node = `/dev/bus/usb/${read(dir, 'busnum').padStart(3, '0')}/${read(dir, 'devnum').padStart(3, '0')}`;
    let writable = false;
    try {
      fs.accessSync(node, fs.constants.W_OK);
      writable = true;
    } catch {
      /* no access */
    }
    const kinds = [...new Set(ifClasses.map((c) => CLASS_LABEL[c]).filter(Boolean))];
    devices.push({ id, name: product || names[id] || `USB device ${id}`, kinds, writable, node });
  }
  return devices.sort((a, b) => Number(b.kinds.includes('storage')) - Number(a.kinds.includes('storage')) || a.name.localeCompare(b.name));
}

/** Shell command that grants the logged-in user access to these devices (one-time, needs sudo). */
function udevCommand(ids) {
  const rules = ids
    .map((id) => {
      const [vid, pid] = id.split(':');
      return `SUBSYSTEM=="usb", ATTR{idVendor}=="${vid}", ATTR{idProduct}=="${pid}", TAG+="uaccess"`;
    })
    .join('\\n');
  return (
    `printf '${rules}\\n' | sudo tee -a /etc/udev/rules.d/70-devbox-usb.rules >/dev/null` +
    ' && sudo udevadm control --reload && sudo udevadm trigger --subsystem-match=usb'
  );
}

module.exports = { listDevices, udevCommand };
