/**
 * ESP32 StreamLine console.
 *
 * Plain JS, structured for maintainability: every API payload has a JSDoc
 * typedef mirroring the serde structs in `src/adapters/http.rs` (change one,
 * change the other), all mutable state lives in the single `state` object,
 * and the file is grouped into sections — helpers, auth, API, rendering,
 * wiring. Biome enforces lint and format (`make firmware-lint`).
 */

// --- API payload shapes (mirror src/adapters/http.rs) -----------------------

/**
 * @typedef {Object} DeviceStatus
 * @property {string} firmware_version
 * @property {string} mode "streaming" | "setup-ap"
 * @property {string} config_source
 * @property {boolean} configuration_writable
 * @property {boolean} auth_required
 * @property {{ ssid: string, status: string, sta_ip: string, ap_ip: string, rssi: number }} wifi
 * @property {{ target_host: string, target_port: number }} target
 * @property {{ input_line: number, input_gain: number, adc_atten_db: number,
 *              sample_rate: number, channels: number, bits_per_sample: number }} audio
 * @property {{ sequence: number, playing: boolean, clip_threshold_abs: number,
 *              peak_abs_left: number, peak_abs_right: number, rms_left: number, rms_right: number,
 *              clipped_samples_total: number }} metrics
 * @property {OtaSnapshot} ota
 */

/**
 * @typedef {Object} OtaSnapshot
 * @property {string} phase
 * @property {number} bytes_written
 * @property {number} bytes_total
 * @property {string} latest_version
 * @property {string} message
 * @property {boolean} busy
 */

/**
 * @typedef {Object} DeviceConfig
 * @property {string} ssid
 * @property {string} target_host
 * @property {number} target_port
 * @property {number} input_line
 * @property {number} input_gain
 * @property {number} adc_atten_db
 */

// --- Mutable state -----------------------------------------------------------

const state = {
  /** @type {DeviceStatus | null} */
  status: null,
  /** Admin key generated during first-time setup, shown once. */
  setupKey: '',
  /** Replacement admin key staged in the Advanced tab. */
  replacementKey: '',
  /** Last OTA phase written to the activity log, to log each phase once. */
  otaLoggedPhase: /** @type {string | null} */ (null),
  /** Latest release version reported by the last OTA check. */
  otaLatest: '',
  /** Guards the status poll against overlapping slow requests. */
  refreshing: false,
};

// --- DOM helpers -------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const msg = $('message');

function setMsg(text, cls = '') {
  msg.textContent = text;
  msg.className = `msg ${cls}`;
}

function dbfs(abs) {
  if (!abs) return '-inf dBFS';
  return `${(20 * Math.log10(abs / 32768)).toFixed(1)} dBFS`;
}

/** Replace `el`'s content with label/value rows for the .kv grid. */
function kv(el, rows) {
  el.innerHTML = '';
  for (const [k, v] of rows) {
    const a = document.createElement('div');
    a.textContent = k;
    const b = document.createElement('div');
    b.textContent = v;
    el.append(a, b);
  }
}

function setMetricClass(el, good) {
  el.classList.toggle('good', good);
  el.classList.toggle('bad', !good);
}

function setDisabled(selector, disabled) {
  for (const el of document.querySelectorAll(selector)) {
    el.disabled = disabled;
    el.title = disabled ? 'Unlock settings with the admin key' : '';
  }
}

// --- Admin key: storage, unlock window, generation ---------------------------

const ADMIN_KEY_STORAGE = 'streamline_admin_key';
const LEGACY_TOKEN_STORAGE = 'streamline_token';
const UNLOCK_UNTIL_STORAGE = 'streamline_unlock_until';
const UNLOCK_WINDOW_MS = 15 * 60 * 1000;

function storedAdminKey() {
  return (
    sessionStorage.getItem(ADMIN_KEY_STORAGE) ||
    localStorage.getItem(ADMIN_KEY_STORAGE) ||
    localStorage.getItem(LEGACY_TOKEN_STORAGE) ||
    ''
  );
}

function rememberAdminKey(key, remember) {
  sessionStorage.setItem(ADMIN_KEY_STORAGE, key);
  if (remember) {
    localStorage.setItem(ADMIN_KEY_STORAGE, key);
  } else {
    localStorage.removeItem(ADMIN_KEY_STORAGE);
    localStorage.removeItem(LEGACY_TOKEN_STORAGE);
  }
}

function unlockUntil() {
  return Number(sessionStorage.getItem(UNLOCK_UNTIL_STORAGE) || '0');
}

function isUnlocked() {
  return Boolean(storedAdminKey()) && unlockUntil() > Date.now();
}

function unlockSettings(key, remember) {
  rememberAdminKey(key, remember);
  sessionStorage.setItem(UNLOCK_UNTIL_STORAGE, String(Date.now() + UNLOCK_WINDOW_MS));
  updateAuthUi();
  setProtectedControls();
}

function lockSettings(showMessage = true) {
  sessionStorage.removeItem(UNLOCK_UNTIL_STORAGE);
  updateAuthUi();
  setProtectedControls();
  if (showMessage) setMsg('settings locked', 'ok');
}

function generateAdminKey() {
  if (!window.crypto || !window.crypto.getRandomValues) {
    throw new Error('secure random generation is unavailable in this browser');
  }
  const bytes = new Uint8Array(24);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function copySecret(value) {
  if (!value) return;
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }
  // The device serves plain HTTP, so the async clipboard API is unavailable
  // and the deprecated fallback is the only path that works.
  const scratch = document.createElement('textarea');
  scratch.value = value;
  scratch.setAttribute('readonly', '');
  scratch.style.position = 'fixed';
  scratch.style.opacity = '0';
  document.body.appendChild(scratch);
  scratch.select();
  document.execCommand('copy');
  scratch.remove();
}

// --- API ----------------------------------------------------------------------

/** Fetch a JSON API endpoint, attaching the admin key to mutating requests. */
async function api(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const headers = Object.assign({}, opts.headers);
  const key = storedAdminKey();
  if (method !== 'GET' && key && isUnlocked()) headers.Authorization = `Bearer ${key}`;
  const r = await fetch(path, Object.assign({}, opts, { headers }));
  const text = await r.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  if (r.status === 401) {
    lockSettings(false);
    throw new Error('unauthorized — unlock settings with the admin key');
  }
  if (!r.ok) throw new Error(data.error || text || String(r.status));
  return data;
}

function formBody(form) {
  return new URLSearchParams(new FormData(form));
}

// --- Status rendering ----------------------------------------------------------

/** @param {DeviceStatus} s */
function applyStatus(s) {
  state.status = s;
  $('subtitle').textContent =
    `v${s.firmware_version} / ${s.audio.sample_rate} Hz / ` +
    `${s.audio.channels} ch / ${s.audio.bits_per_sample} bit`;
  $('mode').textContent = s.mode;
  $('playing').textContent = s.metrics.playing ? 'yes' : 'no';
  setMetricClass($('playingMetric'), s.metrics.playing);
  $('staIp').textContent = s.wifi.sta_ip;
  $('targetAddr').textContent = `${s.target.target_host}:${s.target.target_port}`;
  $('clipsLast').textContent = s.metrics.clipped_samples_total;
  $('peakLR').textContent = `${dbfs(s.metrics.peak_abs_left)} / ${dbfs(s.metrics.peak_abs_right)}`;
  $('rmsLR').textContent = `${dbfs(s.metrics.rms_left)} / ${dbfs(s.metrics.rms_right)}`;
  $('rssi').textContent = `${s.wifi.rssi} dBm`;
  $('sequence').textContent = s.metrics.sequence;
  setMetricClass($('clipMetric'), s.metrics.clipped_samples_total === 0);
  setMetricClass($('modeMetric'), s.mode === 'streaming');
  kv($('runtimeKv'), [
    ['Config', s.config_source],
    ['SSID', s.wifi.ssid],
    ['Wi-Fi Status', s.wifi.status],
    ['AP IP', s.wifi.ap_ip],
    ['Clip Total', s.metrics.clipped_samples_total],
  ]);
  kv($('audioKv'), [
    ['Input Line', s.audio.input_line],
    ['Input Gain', s.audio.input_gain],
    ['ADC Attenuation', `${s.audio.adc_atten_db} dB`],
    ['Clip Threshold', s.metrics.clip_threshold_abs],
    ['Peak L', dbfs(s.metrics.peak_abs_left)],
    ['Peak R', dbfs(s.metrics.peak_abs_right)],
  ]);
  $('apiDump').textContent = JSON.stringify(s, null, 2);
  $('clip_threshold').value = s.metrics.clip_threshold_abs;
  applyOta(s.firmware_version, s.ota);
  updateAuthUi();
  setProtectedControls();
}

// --- Firmware update -----------------------------------------------------------

const PHASE_LABELS = {
  idle: 'Idle',
  checking: 'Checking…',
  'up-to-date': 'Up to date',
  'update-available': 'Update available',
  downloading: 'Downloading…',
  verifying: 'Verifying…',
  installed: 'Installed',
  failed: 'Failed',
};

function prettyPhase(p) {
  return PHASE_LABELS[p] || p;
}

function logOta(line, cls = '') {
  const el = $('otaLog');
  for (const n of el.querySelectorAll('.dim')) n.remove();
  const row = document.createElement('div');
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = `${new Date().toLocaleTimeString()}  `;
  const m = document.createElement('span');
  if (cls) m.className = cls;
  m.textContent = line;
  row.append(t, m);
  el.append(row);
  el.scrollTop = el.scrollHeight;
}

function beginOtaSession(line) {
  $('otaLog').innerHTML = '';
  state.otaLoggedPhase = null;
  logOta(line);
}

/**
 * @param {string} current running firmware version
 * @param {OtaSnapshot} o
 */
function applyOta(current, o) {
  if (!o) return;
  state.otaLatest = o.latest_version || '';

  const rows = [
    ['Current', `v${current}`],
    ['Latest', state.otaLatest ? `v${state.otaLatest}` : '—'],
    ['Status', prettyPhase(o.phase)],
  ];
  if (o.phase === 'downloading' && o.bytes_total) {
    rows.push(['Progress', `${Math.round((100 * o.bytes_written) / o.bytes_total)}%`]);
  }
  kv($('otaKv'), rows);

  $('checkButton').disabled = o.busy;
  const install = $('installButton');
  if (o.phase === 'update-available') {
    install.hidden = false;
    install.disabled = o.busy;
    install.textContent = `Install v${state.otaLatest}`;
  } else if (o.phase === 'downloading' || o.phase === 'verifying' || o.phase === 'installed') {
    install.hidden = false;
    install.disabled = true;
    install.textContent = 'Installing…';
  } else {
    install.hidden = true;
  }

  // Append a line to the activity log whenever the phase advances. Transient
  // sub-states share a phase, so this stays quiet.
  if (o.phase !== 'idle' && o.phase !== state.otaLoggedPhase) {
    state.otaLoggedPhase = o.phase;
    let line = prettyPhase(o.phase);
    const detailed =
      o.phase === 'up-to-date' ||
      o.phase === 'update-available' ||
      o.phase === 'installed' ||
      o.phase === 'failed';
    if (detailed && o.message) line += ` — ${o.message}`;
    logOta(line, o.phase === 'failed' ? 'err' : o.phase === 'installed' ? 'ok' : '');
  }
}

// --- Auth-gated controls ---------------------------------------------------------

function settingsWritable() {
  if (!state.status) return false;
  if (state.status.configuration_writable === false) return false;
  return !state.status.auth_required || isUnlocked();
}

function setProtectedControls() {
  const writable = settingsWritable();
  setDisabled(
    '#setupForm input:not([type="hidden"]),#setupForm button,#audioForm input,#audioForm select,#audioForm button,#resetButton,#checkButton,#installButton',
    !writable,
  );
  const keyManageable = Boolean(state.status?.auth_required && isUnlocked());
  setDisabled('#adminKeyForm input,#adminKeyForm button', !keyManageable);
  $('copyReplacementKeyButton').disabled = !state.replacementKey || !keyManageable;
}

function ensureSetupKey() {
  if (!state.setupKey) state.setupKey = generateAdminKey();
  $('admin_secret').value = state.setupKey;
  $('setupKeyValue').textContent = state.setupKey;
  $('setupKeyPanel').hidden = false;
}

function clearSetupKey() {
  state.setupKey = '';
  $('admin_secret').value = '';
  $('setupKeyValue').textContent = '';
  $('setupKeyPanel').hidden = true;
}

function stageReplacementKey() {
  state.replacementKey = generateAdminKey();
  $('replacement_admin_secret').value = state.replacementKey;
  $('replacementKeyValue').textContent = state.replacementKey;
  $('replacementKeyPanel').hidden = false;
}

function updateAuthUi() {
  const authState = $('authState');
  const show = (visible) => {
    $('unlockSecret').hidden = !visible;
    $('rememberKeyLabel').hidden = !visible;
    $('unlockButton').hidden = !visible;
  };

  if (!state.status) {
    authState.textContent = 'Auth: checking';
    authState.className = 'authState';
    show(false);
    $('lockButton').hidden = true;
    return;
  }

  if (!state.status.auth_required) {
    ensureSetupKey();
    authState.textContent = 'Auth: setup mode';
    authState.className = 'authState unlocked';
    show(false);
    $('lockButton').hidden = true;
    return;
  }

  clearSetupKey();
  if (isUnlocked()) {
    const until = new Date(unlockUntil()).toLocaleTimeString();
    authState.textContent = `Auth: unlocked until ${until}`;
    authState.className = 'authState unlocked';
    show(false);
    $('lockButton').hidden = false;
  } else {
    const key = storedAdminKey();
    authState.textContent = key ? 'Auth: locked, key saved' : 'Auth: locked';
    authState.className = 'authState locked';
    show(true);
    $('unlockSecret').value = key;
    $('rememberKey').checked = Boolean(localStorage.getItem(ADMIN_KEY_STORAGE));
    $('lockButton').hidden = true;
  }
}

// --- Polling and form wiring -------------------------------------------------------

async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    applyStatus(await api('/api/status'));
  } catch (e) {
    setMsg(e.message, 'err');
  } finally {
    state.refreshing = false;
  }
}

async function loadConfig() {
  /** @type {DeviceConfig} */
  const c = await api('/api/config');
  $('ssid').value = c.ssid;
  $('target_host').value = c.target_host;
  $('target_port').value = c.target_port;
  $('input_line').value = c.input_line;
  $('input_gain').value = c.input_gain;
  $('adc_atten_db').value = c.adc_atten_db;
}

function validateSetup() {
  const host = $('target_host').value.trim();
  if (host.includes(':') || host.includes('/')) {
    throw new Error('TCP target host must not include port, scheme, or path');
  }
  if (state.status && !state.status.auth_required) ensureSetupKey();
}

/** Wire an async handler and surface its failure in the message line. */
function onClick(id, handler) {
  $(id).addEventListener('click', () => {
    Promise.resolve()
      .then(handler)
      .catch((err) => setMsg(err.message, 'err'));
  });
}

/** Wire a form submit to a POST, with a success message. */
function onSubmit(id, path, okMessage, before = () => {}) {
  $(id).addEventListener('submit', (e) => {
    e.preventDefault();
    Promise.resolve()
      .then(() => before())
      .then(() => api(path, { method: 'POST', body: formBody(e.target) }))
      .then(() => setMsg(okMessage, 'ok'))
      .catch((err) => setMsg(err.message, 'err'));
  });
}

for (const b of document.querySelectorAll('.tab')) {
  b.addEventListener('click', () => {
    for (const x of document.querySelectorAll('.tab,.section')) x.classList.remove('active');
    b.classList.add('active');
    $(b.dataset.tab).classList.add('active');
  });
}

onClick('unlockButton', () => {
  const key = $('unlockSecret').value.trim();
  if (key.length < 8) throw new Error('admin key must be at least 8 characters');
  unlockSettings(key, $('rememberKey').checked);
  setMsg('');
});

$('lockButton').addEventListener('click', () => lockSettings(false));

onClick('copySetupKeyButton', async () => {
  await copySecret(state.setupKey);
  setMsg('admin key copied', 'ok');
});

onClick('generateReplacementKeyButton', () => {
  stageReplacementKey();
  setProtectedControls();
});

onClick('copyReplacementKeyButton', async () => {
  await copySecret(state.replacementKey);
  setMsg('new admin key copied', 'ok');
});

onSubmit('setupForm', '/api/setup', 'setup saved; rebooting', validateSetup);

onSubmit('audioForm', '/api/audio', 'audio saved; rebooting');

$('adminKeyForm').addEventListener('submit', (e) => {
  e.preventDefault();
  Promise.resolve()
    .then(() => {
      if (!isUnlocked()) throw new Error('unlock settings before replacing the admin key');
      if (!state.replacementKey) stageReplacementKey();
      return api('/api/admin-key', { method: 'POST', body: formBody(e.target) });
    })
    .then(() => {
      unlockSettings(state.replacementKey, $('rememberReplacementKey').checked);
      setMsg('admin key saved', 'ok');
    })
    .catch((err) => setMsg(err.message, 'err'));
});

onClick('resetButton', async () => {
  if (!confirm('Clear saved config and reboot?')) return;
  await api('/api/reset', { method: 'POST' });
  setMsg('config cleared; rebooting', 'ok');
});

onClick('checkButton', async () => {
  beginOtaSession('Checking GitHub for a newer release…');
  try {
    await api('/api/ota/check', { method: 'POST' });
  } catch (err) {
    logOta(err.message, 'err');
  }
});

onClick('installButton', async () => {
  const target = state.otaLatest ? `v${state.otaLatest}` : 'the latest release';
  if (!confirm(`Install ${target} and reboot the device?`)) return;
  beginOtaSession(`Installing ${target}…`);
  try {
    await api('/api/ota/update', { method: 'POST' });
  } catch (err) {
    logOta(err.message, 'err');
  }
});

Promise.all([loadConfig(), refresh()]).catch((e) => setMsg(e.message, 'err'));
setInterval(refresh, 1500);
