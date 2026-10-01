// Tiny logger that mirrors to stdout and to the renderer's diagnostics panel.
const listeners = new Set();
const history = [];

function log(level, ...parts) {
  const msg = parts.map((p) => (p instanceof Error ? p.stack || p.message : typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  const entry = { t: new Date().toISOString(), level, msg };
  history.push(entry);
  if (history.length > 1000) history.shift();
  (level === 'error' ? console.error : console.log)(`[${level}] ${msg}`);
  for (const fn of listeners) fn(entry);
}

module.exports = {
  info: (...p) => log('info', ...p),
  warn: (...p) => log('warn', ...p),
  error: (...p) => log('error', ...p),
  debug: (...p) => log('debug', ...p),
  subscribe: (fn) => listeners.add(fn),
  history: () => history.slice(),
};
