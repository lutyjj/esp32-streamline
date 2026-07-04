/**
 * StreamLine console.
 *
 * Plain JS, structured for maintainability: every API payload has a JSDoc
 * typedef mirroring the serde structs in `src/adapters/http.rs` (change one,
 * change the other), all mutable state lives in the single `state` object,
 * and the file is grouped into sections — helpers, auth, API, transactions,
 * rendering, wiring. Biome enforces lint and format (`make firmware-lint`).
 *
 * Every mutation runs one visible lifecycle: busy button → per-card result →
 * for rebooting actions a countdown toast, an expected-offline window, and a
 * "back online" confirmation when polling recovers.
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
 *              noise_floor: number, clipped_samples_total: number, packets: number,
 *              queue_drops_total: number, network_errors_total: number,
 *              reconnects_total: number, queue_depth: number, read_errors: number,
 *              short_reads: number, bytes: number }} metrics
 * @property {{ reset_reason: string, last_fallback: string, last_ota: string }} diagnostics
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
  /** Replacement admin key staged in the System tab. */
  replacementKey: '',
  /** Last OTA phase written to the activity log, to log each phase once. */
  otaLoggedPhase: /** @type {string | null} */ (null),
  /** Latest release version reported by the last OTA check. */
  otaLatest: '',
  /** Set while a reboot is expected: polls may fail without alarming anyone. */
  rebootWait: /** @type {{ label: string, failedPolls: number } | null} */ (null),
  /** Packets seen on the previous poll, to tell whether audio still flows. */
  lastPackets: -1,
  /** True while the Wi-Fi password field accepts a replacement password. */
  editingPassword: false,
  /** Peak-hold state per channel for the level meters. */
  peakHold: { left: 0, right: 0, at: 0 },
  /** Guards the status poll against overlapping slow requests. */
  refreshing: false,
  /** True once the clip callout was dismissed this session. */
  clipDismissed: false,
};

// --- DOM helpers -------------------------------------------------------------

const $ = (id) => document.getElementById(id);

function dbfs(abs) {
  if (!abs) return '-inf';
  return (20 * Math.log10(abs / 32768)).toFixed(1);
}

/** Replace `el`'s content with dt/dd rows. */
function kv(el, rows) {
  el.innerHTML = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    el.append(dt, dd);
  }
}

function toast(text, cls = 'ok', ms = 4000) {
  const t = document.createElement('div');
  t.className = `toast ${cls}`;
  t.textContent = text;
  $('toasts').append(t);
  if (ms) setTimeout(() => t.remove(), ms);
  return t;
}

/** The .actionstate element that reports for `button`'s card section. */
function actionState(button) {
  const foot = button.closest('.cardfoot') || button.closest('form') || button.parentElement;
  return foot ? foot.querySelector('.actionstate') : null;
}

function setActionState(button, text, cls = '') {
  const el = actionState(button);
  if (!el) return;
  el.textContent = text;
  el.className = `actionstate ${cls}`;
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

function forgetAdminKey() {
  sessionStorage.removeItem(ADMIN_KEY_STORAGE);
  localStorage.removeItem(ADMIN_KEY_STORAGE);
  localStorage.removeItem(LEGACY_TOKEN_STORAGE);
  sessionStorage.removeItem(UNLOCK_UNTIL_STORAGE);
  renderAuth();
}

/** Ask the device whether it accepts `key`; throws when it cannot answer. */
async function verifyAdminKey(key) {
  const r = await fetch('/api/unlock', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
  });
  if (r.status === 401) return false;
  if (!r.ok) throw new Error(`unlock failed: HTTP ${r.status}`);
  return true;
}

function unlockSettings(key, remember) {
  rememberAdminKey(key, remember);
  sessionStorage.setItem(UNLOCK_UNTIL_STORAGE, String(Date.now() + UNLOCK_WINDOW_MS));
  renderAuth();
}

function lockSettings() {
  sessionStorage.removeItem(UNLOCK_UNTIL_STORAGE);
  renderAuth();
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
    lockSettings();
    throw new Error('unauthorized — unlock settings with the admin key');
  }
  if (!r.ok) throw new Error(data.error || text || String(r.status));
  return data;
}

function formBody(form) {
  return new URLSearchParams(new FormData(form));
}

// --- Transactions: one lifecycle for every mutation ---------------------------

/**
 * Run `work` behind `button` with the full visible lifecycle. `reboots` labels
 * a device restart so the expected offline window is narrated instead of
 * looking like a failure.
 */
async function transact(button, work, { busyText, okText, reboots = '' } = {}) {
  if (button.disabled) return;
  button.disabled = true;
  button.classList.add('busy');
  setActionState(button, busyText || 'Working…');
  try {
    await work();
    if (reboots) {
      setActionState(button, `Saved — device is restarting`, 'ok');
      beginRebootWait(reboots);
    } else {
      setActionState(button, okText || 'Done', 'ok');
    }
  } catch (err) {
    setActionState(button, err.message, 'err');
  } finally {
    button.classList.remove('busy');
    button.disabled = false;
    renderGating();
  }
}

/** Failed polls (~1.5 s each) before warning that a reboot is overdue. */
const REBOOT_WARN_POLLS = 40;

function beginRebootWait(label) {
  state.rebootWait = { label, failedPolls: 0 };
  toast(`Restarting to apply ${label} — the console reconnects by itself`, 'wait', 8000);
}

function rebootWaitTick(pollFailed) {
  const wait = state.rebootWait;
  if (!wait) return;
  if (!pollFailed) {
    state.rebootWait = null;
    $('connBanner').hidden = true;
    toast(`Back online — ${wait.label} applied`, 'ok');
    loadConfig().catch(() => {});
    return;
  }
  wait.failedPolls += 1;
  if (wait.failedPolls === REBOOT_WARN_POLLS) {
    toast(
      'Still offline after a minute — the device may have fallen back to its setup network; check your Wi-Fi list for esp32-streamline-…',
      'err',
      0,
    );
  }
}

// --- Status rendering ----------------------------------------------------------

/** @param {DeviceStatus} s */
function applyStatus(s) {
  const first = !state.status;
  state.status = s;

  $('chipVersion').textContent = `v${s.firmware_version}`;
  $('chipFormat').textContent =
    `${s.audio.sample_rate / 1000} kHz / ${s.audio.bits_per_sample}-bit`;
  $('chipAddr').textContent = s.mode === 'setup-ap' ? s.wifi.ap_ip : s.wifi.sta_ip;

  renderHealth(s);
  renderMeters(s);
  renderClipCallout(s);
  renderDiagnostics(s);
  renderOta(s.firmware_version, s.ota);
  renderAuth();
  $('apiDump').textContent = JSON.stringify(s, null, 2);

  state.lastPackets = s.metrics.packets;
  if (first && s.mode === 'setup-ap') showView('network');
}

/** @param {DeviceStatus} s */
function renderHealth(s) {
  const playing = s.metrics.playing;
  const setup = s.mode === 'setup-ap';
  $('hStatus').textContent = setup ? 'Setup' : playing ? 'Streaming' : 'Idle';
  $('hStatusSub').textContent = setup
    ? 'waiting for first-time setup'
    : playing
      ? 'input carries signal'
      : 'input is quiet';
  $('dotStatus').className = `statusdot ${setup ? 'warn' : playing ? 'good' : ''}`;

  const rms = Math.max(s.metrics.rms_left, s.metrics.rms_right);
  $('hSignal').textContent = `${dbfs(rms)} dBFS`;
  $('hSignalSub').textContent = s.metrics.clipped_samples_total
    ? `${s.metrics.clipped_samples_total} clipped since restart`
    : 'no clipping since restart';

  $('hWifi').textContent = s.wifi.ssid || '—';
  $('hWifiSub').textContent = setup
    ? `setup network at ${s.wifi.ap_ip}`
    : `${s.wifi.rssi} dBm · ${s.wifi.sta_ip}`;

  const moving = state.lastPackets >= 0 && s.metrics.packets > state.lastPackets;
  $('hBridge').textContent = setup ? '—' : moving ? 'Sending' : playing ? 'Connecting' : 'Idle';
  $('dotBridge').className = `statusdot ${moving ? 'good' : playing ? 'warn' : ''}`;
  $('hBridgeSub').textContent = `${s.target.target_host}:${s.target.target_port}`;

  $('wifiLead').textContent = setup
    ? 'Not configured yet — join the device to your home network.'
    : `Connected to ${s.wifi.ssid} · ${s.wifi.rssi} dBm`;
}

const PEAK_HOLD_MS = 2500;

/** @param {DeviceStatus} s */
function renderMeters(s) {
  const pct = (abs) => {
    if (!abs) return 0;
    const db = 20 * Math.log10(abs / 32768);
    return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  };
  const now = Date.now();
  const hold = state.peakHold;
  const peakL = s.metrics.peak_abs_left;
  const peakR = s.metrics.peak_abs_right;
  if (peakL >= hold.left || now - hold.at > PEAK_HOLD_MS) {
    hold.left = peakL;
    hold.at = now;
  }
  if (peakR >= hold.right || now - hold.at > PEAK_HOLD_MS) hold.right = peakR;

  for (const el of document.querySelectorAll('[data-meter="fillL"]')) {
    el.style.clipPath = `inset(0 ${100 - pct(s.metrics.rms_left)}% 0 0)`;
  }
  for (const el of document.querySelectorAll('[data-meter="fillR"]')) {
    el.style.clipPath = `inset(0 ${100 - pct(s.metrics.rms_right)}% 0 0)`;
  }
  for (const el of document.querySelectorAll('[data-meter="peakL"]')) {
    el.style.left = `calc(${pct(hold.left)}% - 1px)`;
  }
  for (const el of document.querySelectorAll('[data-meter="peakR"]')) {
    el.style.left = `calc(${pct(hold.right)}% - 1px)`;
  }

  $('rmsRead').textContent = `RMS ${dbfs(s.metrics.rms_left)} / ${dbfs(s.metrics.rms_right)}`;
  $('peakRead').textContent =
    `Peak ${dbfs(s.metrics.peak_abs_left)} / ${dbfs(s.metrics.peak_abs_right)}`;
  $('floorRead').textContent = s.metrics.noise_floor
    ? `noise floor ${dbfs(s.metrics.noise_floor)} dBFS`
    : '';
  $('clipLamp').classList.toggle('lit', Math.max(peakL, peakR) >= s.metrics.clip_threshold_abs);
}

/** @param {DeviceStatus} s */
function renderClipCallout(s) {
  const clips = s.metrics.clipped_samples_total;
  const show = clips > 0 && !state.clipDismissed && s.mode !== 'setup-ap';
  $('clipCallout').hidden = !show;
  if (show) {
    $('clipCalloutText').textContent =
      ` ${clips} samples hit full scale since the last restart — raise the ADC attenuation until loud passages stay clean.`;
  }
}

/** @param {DeviceStatus} s */
function renderDiagnostics(s) {
  const rows = [
    ['Last boot', s.diagnostics?.reset_reason || '—'],
    ['Config source', s.config_source],
    ['Packets sent', `${s.metrics.packets} · ${s.metrics.queue_drops_total} dropped`],
    [
      'Network',
      `${s.metrics.network_errors_total} send errors · ${s.metrics.reconnects_total} reconnects`,
    ],
    ['Capture', `${s.metrics.read_errors} read errors · ${s.metrics.short_reads} short reads`],
    ['Sequence', String(s.metrics.sequence)],
    ['Detector floor', `${s.metrics.noise_floor} RMS`],
  ];
  if (s.diagnostics?.last_ota) rows.push(['Last update', s.diagnostics.last_ota]);
  if (s.diagnostics?.last_fallback) rows.push(['Last AP fallback', s.diagnostics.last_fallback]);
  kv($('diagKv'), rows);
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

/** Phases during which losing the device most likely means it is rebooting. */
const OTA_REBOOT_PHASES = ['downloading', 'verifying', 'installed'];

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
function renderOta(current, o) {
  if (!o) return;
  state.otaLatest = o.latest_version || '';

  const rows = [
    ['Installed', `v${current}`],
    ['Latest release', state.otaLatest ? `v${state.otaLatest}` : '—'],
    ['Status', prettyPhase(o.phase)],
  ];
  if (o.phase === 'downloading' && o.bytes_total) {
    rows.push(['Progress', `${Math.round((100 * o.bytes_written) / o.bytes_total)}%`]);
  }
  kv($('otaKv'), rows);

  $('checkButton').disabled = o.busy || !settingsWritable();
  const install = $('installButton');
  if (o.phase === 'update-available') {
    install.hidden = false;
    install.disabled = o.busy || !settingsWritable();
    install.textContent = `Install v${state.otaLatest}`;
  } else if (OTA_REBOOT_PHASES.includes(o.phase)) {
    install.hidden = false;
    install.disabled = true;
    install.textContent = 'Installing…';
  } else {
    install.hidden = true;
  }

  // Append a line to the activity log whenever the phase advances. If the
  // device goes offline in an installing phase, the reboot narration below
  // takes over.
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
    if (o.phase === 'installed' && !state.rebootWait) beginRebootWait('the firmware update');
  }
}

// --- Auth rendering and gating ---------------------------------------------------

function settingsWritable() {
  if (!state.status) return false;
  if (state.status.configuration_writable === false) return false;
  return !state.status.auth_required || isUnlocked();
}

function renderAuth() {
  const chip = $('lockChip');
  const s = state.status;
  if (!s) {
    chip.className = 'lockchip';
    $('lockText').textContent = 'Checking…';
    $('lockSub').textContent = '';
    return;
  }

  if (!s.auth_required) {
    ensureSetupKey();
    chip.className = 'lockchip unlocked';
    $('lockText').textContent = 'Setup mode';
    $('lockSub').textContent = '· no key yet';
    $('unlockPanel').hidden = true;
  } else if (isUnlocked()) {
    clearSetupKey();
    chip.className = 'lockchip unlocked';
    $('lockText').textContent = 'Unlocked';
    const minutes = Math.max(1, Math.round((unlockUntil() - Date.now()) / 60000));
    $('lockSub').textContent = `· ${minutes} min left — click to lock`;
    $('unlockPanel').hidden = true;
  } else {
    clearSetupKey();
    chip.className = 'lockchip locked';
    $('lockText').textContent = 'Locked';
    $('lockSub').textContent = storedAdminKey()
      ? '· key saved — click to unlock'
      : '· click to unlock';
    // Never write the saved key into the input: the field belongs to the user.
    $('unlockSecret').placeholder = storedAdminKey() ? 'saved key used if empty' : 'admin key';
    $('forgetKeyButton').hidden = !storedAdminKey();
  }
  renderGating();
}

function renderGating() {
  const writable = settingsWritable();
  document.body.classList.toggle('locked', !writable);
  const gate =
    '#audioForm input,#audioForm select,#audioForm button,' +
    '#setupForm input:not([type="hidden"]),#setupForm button,' +
    '#customOtaForm input,#customOtaForm button,#factoryButton';
  for (const el of document.querySelectorAll(gate)) {
    el.disabled = !writable;
    el.title = writable ? '' : 'Unlock settings with the admin key';
  }
  const keyManageable = Boolean(state.status?.auth_required && isUnlocked());
  for (const el of document.querySelectorAll('#adminKeyForm input,#adminKeyForm button')) {
    el.disabled = !keyManageable;
  }
  $('copyReplacementKeyButton').disabled = !state.replacementKey || !keyManageable;
  renderPasswordControls();
}

function renderPasswordControls() {
  const firstSetup = state.status?.auth_required === false;
  const writable = settingsWritable();
  const editing = firstSetup || state.editingPassword;
  $('editPassButton').hidden = firstSetup;
  $('editPassButton').textContent = state.editingPassword ? 'Keep current' : 'Change';
  $('editPassButton').disabled = !writable;
  $('password').disabled = !writable || !editing;
  $('password').autocomplete = firstSetup ? 'new-password' : 'off';
  $('password').placeholder = firstSetup
    ? 'network password'
    : editing
      ? 'new password'
      : 'unchanged';
  $('passwordHelp').textContent = firstSetup
    ? 'The password of the Wi-Fi network the device should join.'
    : 'The saved password stays unless you change it here.';
  if (!editing) $('password').value = '';
}

// --- First-run setup key -------------------------------------------------------

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
  renderGating();
}

// --- Polling -------------------------------------------------------------------

async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    applyStatus(await api('/api/status'));
    rebootWaitTick(false);
    $('connBanner').hidden = true;
  } catch {
    if (state.rebootWait) {
      rebootWaitTick(true);
    } else if (state.otaLoggedPhase && OTA_REBOOT_PHASES.includes(state.otaLoggedPhase)) {
      beginRebootWait('the firmware update');
    } else if (state.status) {
      $('connBanner').hidden = false;
    }
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
  $('password').value = '';
  state.editingPassword = false;
  renderPasswordControls();
}

// --- Wiring ----------------------------------------------------------------------

function showView(name) {
  for (const b of document.querySelectorAll('.tabs button')) {
    b.setAttribute('aria-selected', String(b.dataset.view === name));
  }
  for (const v of document.querySelectorAll('.view')) {
    v.classList.toggle('active', v.id === `view-${name}`);
  }
}

for (const b of document.querySelectorAll('.tabs button')) {
  b.addEventListener('click', () => showView(b.dataset.view));
}

$('lockChip').addEventListener('click', () => {
  const s = state.status;
  if (!s || !s.auth_required) return;
  if (isUnlocked()) {
    lockSettings();
    toast('Settings locked', 'ok');
  } else {
    $('unlockPanel').hidden = !$('unlockPanel').hidden;
    if (!$('unlockPanel').hidden) $('unlockSecret').focus();
  }
});

$('unlockButton').addEventListener('click', () => {
  const button = $('unlockButton');
  button.classList.add('busy');
  (async () => {
    const typed = $('unlockSecret').value.trim();
    const key = typed || storedAdminKey();
    if (!key) throw new Error('enter the admin key');
    if (!(await verifyAdminKey(key))) {
      if (!typed) {
        forgetAdminKey();
        throw new Error('saved admin key was rejected and forgotten — enter the current key');
      }
      throw new Error('admin key rejected');
    }
    $('unlockSecret').value = '';
    unlockSettings(key, $('rememberKey').checked);
    $('unlockPanel').hidden = true;
    toast('Settings unlocked for 15 minutes', 'ok');
  })()
    .catch((err) => toast(err.message, 'err'))
    .finally(() => button.classList.remove('busy'));
});

$('unlockSecret').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('unlockButton').click();
});

$('forgetKeyButton').addEventListener('click', () => {
  forgetAdminKey();
  toast('Saved admin key forgotten', 'ok');
});

$('editPassButton').addEventListener('click', () => {
  state.editingPassword = !state.editingPassword;
  renderPasswordControls();
  if (state.editingPassword) $('password').focus();
});

$('copySetupKeyButton').addEventListener('click', () => {
  copySecret(state.setupKey).then(
    () => toast('Admin key copied', 'ok'),
    (err) => toast(err.message, 'err'),
  );
});

$('clipCalloutButton').addEventListener('click', () => showView('audio'));

$('audioForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const button = e.target.querySelector('button[type="submit"]');
  transact(button, () => api('/api/audio', { method: 'POST', body: formBody(e.target) }), {
    busyText: 'Saving…',
    reboots: 'the audio settings',
  });
});

$('setupForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const button = e.target.querySelector('button[type="submit"]');
  const firstSetup = state.status?.auth_required === false;
  transact(
    button,
    async () => {
      const host = $('target_host').value.trim();
      if (host.includes(':') || host.includes('/')) {
        throw new Error('target host must not include port, scheme, or path');
      }
      if (!firstSetup && !state.editingPassword) $('password').value = '';
      if (firstSetup) ensureSetupKey();
      await api('/api/setup', { method: 'POST', body: formBody(e.target) });
      if (firstSetup && state.setupKey) {
        // The device reboots onto the home network; keep the key so this
        // browser can unlock it there.
        unlockSettings(state.setupKey, $('rememberSetupKey').checked);
      }
    },
    { busyText: 'Saving…', reboots: 'the network settings' },
  );
  if (firstSetup) {
    toast(
      `The setup network disappears now — reconnect to your own Wi-Fi, then open the device's new address (your router lists it as "streamline").`,
      'wait',
      0,
    );
  }
});

$('adminKeyForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const button = e.target.querySelector('button[type="submit"]');
  transact(
    button,
    async () => {
      if (!isUnlocked()) throw new Error('unlock settings before replacing the admin key');
      if (!state.replacementKey) stageReplacementKey();
      await api('/api/admin-key', { method: 'POST', body: formBody(e.target) });
      unlockSettings(state.replacementKey, $('rememberReplacementKey').checked);
      state.replacementKey = '';
      $('replacementKeyPanel').hidden = true;
    },
    { busyText: 'Saving…', okText: 'New key saved and active' },
  );
});

$('generateReplacementKeyButton').addEventListener('click', stageReplacementKey);

$('copyReplacementKeyButton').addEventListener('click', () => {
  copySecret(state.replacementKey).then(
    () => toast('New admin key copied', 'ok'),
    (err) => toast(err.message, 'err'),
  );
});

$('factoryButton').addEventListener('click', () => {
  $('factoryConfirm').hidden = false;
});
$('factoryNo').addEventListener('click', () => {
  $('factoryConfirm').hidden = true;
});
$('factoryYes').addEventListener('click', () => {
  const button = $('factoryYes');
  transact(
    button,
    async () => {
      await api('/api/reset', { method: 'POST' });
      $('factoryConfirm').hidden = true;
    },
    { busyText: 'Erasing…', reboots: 'the factory reset' },
  );
});

$('checkButton').addEventListener('click', () => {
  beginOtaSession('Checking GitHub for a newer release…');
  transact($('checkButton'), () => api('/api/ota/check', { method: 'POST' }), {
    busyText: 'Checking…',
    okText: '',
  });
});

$('installButton').addEventListener('click', () => {
  const target = state.otaLatest ? `v${state.otaLatest}` : 'the latest release';
  beginOtaSession(`Installing ${target}…`);
  transact($('installButton'), () => api('/api/ota/update', { method: 'POST' }), {
    busyText: 'Installing…',
    okText: 'Install started — progress below',
  });
});

$('customOtaForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const button = e.target.querySelector('button[type="submit"]');
  const url = $('ota_url').value.trim();
  beginOtaSession(`Installing custom image from ${url}…`);
  transact(button, () => api('/api/ota/update', { method: 'POST', body: formBody(e.target) }), {
    busyText: 'Installing…',
    okText: 'Install started — progress below',
  });
});

// Reflect whether a key is persisted; the switch is user-owned from here on.
$('rememberKey').checked = Boolean(localStorage.getItem(ADMIN_KEY_STORAGE));

Promise.all([loadConfig(), refresh()]).catch(() => {
  $('connBanner').hidden = false;
});
setInterval(refresh, 1500);
