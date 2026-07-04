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
 * @property {string} device_name friendly name; empty when unnamed
 * @property {string} mode "streaming" | "setup-ap"
 * @property {string} config_source
 * @property {boolean} configuration_writable
 * @property {boolean} auth_required
 * @property {{ hostname: string, ssid: string, status: string, sta_ip: string,
 *              ap_ip: string, rssi: number }} wifi
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
 * @property {string} device_name
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

function submitButton(event) {
  return event.submitter || event.target.querySelector('button[type="submit"]');
}

// --- Transactions: one lifecycle for every mutation ---------------------------

/**
 * Run `work` behind `button` with the full visible lifecycle. When the device
 * answers `rebooting: true`, `reboots` labels the restart so the expected
 * offline window is narrated instead of looking like a failure.
 */
async function transact(button, work, { busyText, okText, reboots = '' } = {}) {
  if (button.disabled) return;
  button.disabled = true;
  button.classList.add('busy');
  setActionState(button, busyText || 'Working…');
  try {
    const data = await work();
    if (reboots && data?.rebooting) {
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

function beginRebootWait(label, toastText) {
  state.rebootWait = { label, failedPolls: 0 };
  toast(
    toastText || `Restarting to apply ${label} — the console reconnects by itself`,
    'wait',
    8000,
  );
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
  $('chipAddr').textContent =
    s.mode === 'setup-ap' ? s.wifi.ap_ip : s.wifi.hostname || s.wifi.sta_ip;
  $('deviceName').textContent = s.device_name;
  $('deviceName').hidden = !s.device_name;
  document.title = s.device_name ? `${s.device_name} — StreamLine` : 'StreamLine';

  renderHealth(s);
  renderMeters(s);
  renderClipCallout(s);
  renderDiagnostics(s);
  renderOta(s.firmware_version, s.ota);
  renderAuth();
  $('apiDump').textContent = JSON.stringify(s, null, 2);

  state.lastPackets = s.metrics.packets;
  if (first && s.mode === 'setup-ap') openOnboarding();
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
    ? `${s.metrics.clipped_samples_total} clipped since levels were set`
    : 'no clipping';

  $('hWifi').textContent = s.wifi.ssid || '—';
  $('hWifiSub').textContent = setup
    ? `setup network at ${s.wifi.ap_ip}`
    : `${s.wifi.rssi} dBm · ${s.wifi.hostname || s.wifi.sta_ip}`;

  const moving = state.lastPackets >= 0 && s.metrics.packets > state.lastPackets;
  $('hBridge').textContent = setup ? '—' : moving ? 'Sending' : playing ? 'Connecting' : 'Idle';
  $('dotBridge').className = `statusdot ${moving ? 'good' : playing ? 'warn' : ''}`;
  $('hBridgeSub').textContent = `${s.target.target_host}:${s.target.target_port}`;

  // Same bridge verdict, repeated next to the target form so a saved target
  // can be judged where it was typed.
  $('targetHealth').hidden = setup;
  $('targetHealthDot').className = `statusdot ${moving ? 'good' : playing ? 'warn' : ''}`;
  $('targetHealthText').textContent = moving
    ? 'connection healthy'
    : playing
      ? 'connecting to bridge…'
      : 'idle — nothing to send';

  $('wifiLead').textContent = setup
    ? 'Not configured yet — join the device to your home network.'
    : `Connected to ${s.wifi.ssid} · ${s.wifi.rssi} dBm · ${s.wifi.sta_ip}`;
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
      ` ${clips} samples hit full scale since the levels were last set — the recording is distorted at the bridge. Calibration fixes this in about a minute.`;
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

const GATED_CONTROL_SELECTOR =
  '.gated input:not([type="hidden"]),.gated select,.gated textarea,.gated button';

// Preserve disabled states owned by other UI logic, such as password editing
// and OTA progress; the lock only re-enables controls it disabled.
function setLockedGate(el, locked) {
  if (locked) {
    if (!('gateTitle' in el.dataset)) el.dataset.gateTitle = el.getAttribute('title') || '';
    el.title = 'Unlock settings with the admin key';
    if (!el.disabled) {
      el.dataset.gateDisabled = 'true';
      el.disabled = true;
    }
    return;
  }

  if (el.dataset.gateDisabled) {
    el.disabled = false;
    delete el.dataset.gateDisabled;
  }
  if ('gateTitle' in el.dataset) {
    const title = el.dataset.gateTitle;
    if (title) el.title = title;
    else el.removeAttribute('title');
    delete el.dataset.gateTitle;
  }
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
    $('forgetKeyButton').hidden = !storedAdminKey();
  }
  renderGating();
}

function renderGating() {
  const writable = settingsWritable();
  document.body.classList.toggle('locked', !writable);
  for (const el of document.querySelectorAll(GATED_CONTROL_SELECTOR)) setLockedGate(el, !writable);
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
  const c = await api('/api/settings');
  $('device_name').value = c.device_name;
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
    if (!$('unlockPanel').hidden) {
      // A saved key fills the field (masked) so it is visible that Unlock
      // has something to work with; replacing the text uses a different key.
      if (!$('unlockSecret').value) $('unlockSecret').value = storedAdminKey();
      $('rememberKey').checked = Boolean(localStorage.getItem(ADMIN_KEY_STORAGE));
      $('unlockSecret').focus();
    }
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
  $('unlockSecret').value = '';
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

$('clipCalloutButton').addEventListener('click', () => {
  showView('audio');
  if (isUnlocked()) openWizard();
});

$('audioForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const button = submitButton(e);
  transact(button, () => api('/api/settings/audio', { method: 'POST', body: formBody(e.target) }), {
    busyText: 'Saving…',
    okText: 'Saved — the meter shows the new levels',
    // In setup mode the codec is not running, so the device restarts instead.
    reboots: 'the audio settings',
  });
});

// --- Calibration wizard: prepare · silence · loud · done -----------------------

/** Wizard runtime state; null while closed. `run` is a generation counter —
 * every step change bumps it, and measurement loops stop when it moves. */
let wiz = null;

const WIZ_POLL_MS = 500;
/** Polls in the silence measurement (~4 s). */
const WIZ_SILENCE_SAMPLES = 8;
/** Clean polls required at one attenuation before it is accepted (~3 s). */
const WIZ_WINDOW_SAMPLES = 6;
/** Attenuation step between windows; divides the 48 dB range evenly. */
const WIZ_ATTEN_STEP = 3;
const WIZ_ATTEN_MAX = 48;
/** RMS below this is not playback — mirrors the firmware's start gate. */
const WIZ_SIGNAL_RMS = 150;

function wzPct(abs) {
  if (!abs) return 0;
  const db = 20 * Math.log10(abs / 32768);
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
}

function wzLog(text, cls = '') {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = text;
  $('wzLog').append(line);
  $('wzLog').scrollTop = $('wzLog').scrollHeight;
}

function wzDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One telemetry poll reduced to the levels the wizard reasons about. */
async function wzSample() {
  /** @type {DeviceStatus} */
  const s = await api('/api/status');
  return {
    rms: Math.max(s.metrics.rms_left, s.metrics.rms_right),
    peak: Math.max(s.metrics.peak_abs_left, s.metrics.peak_abs_right),
    clipped: s.metrics.clipped_samples_total,
    threshold: s.metrics.clip_threshold_abs,
  };
}

/** Apply an attenuation live, keeping the configured line and gain. */
async function wzApplyAudio(atten) {
  const body = new URLSearchParams({
    line: String(wiz.original.line),
    gain: String(wiz.original.gain),
    atten: String(atten),
  });
  await api('/api/settings/audio', { method: 'POST', body });
  wiz.applied = atten;
}

function openWizard() {
  if (state.status?.mode !== 'streaming') {
    toast('Calibration needs the device streaming on your network', 'err');
    return;
  }
  const audio = state.status.audio;
  wiz = {
    step: 0,
    run: 0,
    original: {
      line: audio.input_line,
      gain: audio.input_gain,
      atten: audio.adc_atten_db,
    },
    applied: null,
    idle: 0,
    idleOk: false,
    result: null,
  };
  $('wizard').hidden = false;
  wzShow(1);
}

async function closeWizard(restore) {
  if (!wiz) return;
  const w = wiz;
  wiz = null;
  $('wizard').hidden = true;
  if (restore && w.applied !== null && w.applied !== w.original.atten) {
    try {
      const body = new URLSearchParams({
        line: String(w.original.line),
        gain: String(w.original.gain),
        atten: String(w.original.atten),
      });
      await api('/api/settings/audio', { method: 'POST', body });
      toast(`Put ADC attenuation back to ${w.original.atten} dB`, 'ok');
    } catch (err) {
      toast(`Could not restore previous levels: ${err.message}`, 'err');
    }
  }
}

function wzShow(step) {
  wiz.step = step;
  wiz.run += 1;
  for (let i = 1; i <= 4; i += 1) $(`wzStep${i}`).hidden = i !== step;
  const dots = $('wzDots').children;
  for (let i = 0; i < dots.length; i += 1) dots[i].classList.toggle('on', i < step);
  $('wizBack').hidden = step === 1;
  $('wizCancel').textContent = step === 4 ? 'Undo & close' : 'Cancel';
  const next = $('wizNext');
  next.hidden = step === 3;
  next.disabled = step === 2;
  if (step === 1) next.textContent = 'Start';
  if (step === 2) {
    next.textContent = 'Continue';
    wzMeasureSilence();
  }
  if (step === 3) wzMeasureLoud();
  if (step === 4) next.textContent = 'Done';
}

async function wzMeasureSilence() {
  const run = wiz.run;
  wiz.idleOk = false;
  $('wzSilenceNote').hidden = true;
  $('wzFloor').textContent = '—';
  $('wzProg').style.width = '0';
  const samples = [];
  for (let i = 0; i < WIZ_SILENCE_SAMPLES; i += 1) {
    await wzDelay(WIZ_POLL_MS);
    if (!wiz || wiz.run !== run) return;
    let sample;
    try {
      sample = await wzSample();
    } catch {
      continue; // a missed poll only stretches the measurement
    }
    if (!wiz || wiz.run !== run) return;
    samples.push(sample.rms);
    $('wzFloor').textContent = sample.rms ? dbfs(sample.rms) : '−∞';
    $('wzProg').style.width = `${((i + 1) / WIZ_SILENCE_SAMPLES) * 100}%`;
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)] || 0;
  $('wzFloor').textContent = median ? dbfs(median) : '−∞';
  const note = $('wzSilenceNote');
  if (median >= WIZ_SIGNAL_RMS) {
    note.textContent =
      'That sounds like playback, not silence — pause the source, then measure again.';
    note.hidden = false;
    $('wizNext').textContent = 'Measure again';
    $('wizNext').disabled = false;
    return;
  }
  wiz.idle = median;
  wiz.idleOk = true;
  $('wizNext').disabled = false;
}

async function wzMeasureLoud() {
  const run = wiz.run;
  $('wzLog').textContent = '';
  let atten = 0;
  const gate = Math.max(WIZ_SIGNAL_RMS, wiz.idle * 3);
  try {
    await wzApplyAudio(atten);
  } catch (err) {
    wzLog(`Could not set attenuation: ${err.message}`);
    return;
  }
  if (!wiz || wiz.run !== run) return;
  wzLog('Waiting for playback — press play and turn it up…');
  let waiting = true;
  let windowStart = null;
  let windowPeak = 0;
  let windowRms = 0;
  let count = 0;
  while (wiz && wiz.run === run) {
    await wzDelay(WIZ_POLL_MS);
    if (!wiz || wiz.run !== run) return;
    let s;
    try {
      s = await wzSample();
    } catch {
      continue;
    }
    if (!wiz || wiz.run !== run) return;
    $('wzFill').style.clipPath = `inset(0 ${100 - wzPct(s.rms)}% 0 0)`;
    $('wzPeak').style.left = `calc(${wzPct(s.peak)}% - 1px)`;
    if (waiting) {
      if (s.rms < gate) continue;
      waiting = false;
      windowStart = null;
      wzLog('Hearing it. Checking 0 dB…');
    }
    if (windowStart === null) {
      // (Re)base the clip counter on this poll so samples clipped under the
      // previous attenuation do not count against the new one.
      windowStart = s.clipped;
      windowPeak = 0;
      windowRms = 0;
      count = 0;
      continue;
    }
    count += 1;
    windowPeak = Math.max(windowPeak, s.peak);
    windowRms = Math.max(windowRms, s.rms);
    if (s.clipped > windowStart || s.peak >= s.threshold) {
      if (atten >= WIZ_ATTEN_MAX) {
        wzLog(
          `Still clipping at ${WIZ_ATTEN_MAX} dB — turn the source volume down, then go Back and retry.`,
        );
        return;
      }
      atten += WIZ_ATTEN_STEP;
      try {
        await wzApplyAudio(atten);
      } catch (err) {
        wzLog(`Could not raise attenuation: ${err.message}`);
        return;
      }
      if (!wiz || wiz.run !== run) return;
      wzLog(`Clipping — raising to ${atten} dB…`);
      windowStart = null;
      continue;
    }
    if (count < WIZ_WINDOW_SAMPLES) continue;
    if (windowRms < gate) {
      wzLog('Signal went quiet — keep the loud part playing…');
      waiting = true;
      continue;
    }
    wiz.result = { atten, peakDb: dbfs(windowPeak) };
    wzLog(`Clean at ${atten} dB — no clipping, peak ${dbfs(windowPeak)} dBFS.`, 'ok');
    wzFinish();
    return;
  }
}

function wzFinish() {
  const r = wiz.result;
  $('wzDoneText').textContent =
    r.atten === wiz.original.atten
      ? 'Your current setting was already right — nothing changed.'
      : 'Applied and saved — the device is already running with the new setting.';
  $('wzDoneKv').textContent = '';
  const rows = [
    [
      'ADC attenuation',
      `${r.atten} dB${r.atten === wiz.original.atten ? ' — unchanged' : ` (was ${wiz.original.atten} dB)`}`,
    ],
    ['Loudest peak', `${r.peakDb} dBFS, no clipping`],
    ['Input gain', `${wiz.original.gain} — unchanged`],
  ];
  for (const [key, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = value;
    $('wzDoneKv').append(dt, dd);
  }
  $('adc_atten_db').value = r.atten;
  wzShow(4);
}

$('calibrateButton').addEventListener('click', openWizard);
$('wizCancel').addEventListener('click', () => closeWizard(true));
$('wizBack').addEventListener('click', () => wzShow(wiz.step - 1));
$('wizNext').addEventListener('click', () => {
  if (wiz.step === 1) wzShow(2);
  else if (wiz.step === 2) wzShow(wiz.idleOk ? 3 : 2);
  else if (wiz.step === 4) closeWizard(false);
});

// --- First-run onboarding: Wi-Fi · admin key · joining -------------------------

let obStep = 0;

function openOnboarding() {
  if (state.status?.mode !== 'setup-ap') return;
  ensureSetupKey();
  obStep = 0;
  $('onboard').hidden = false;
  obShow(1);
}

function closeOnboarding() {
  $('onboard').hidden = true;
  obStep = 0;
  showView('network');
}

function obShow(step) {
  obStep = step;
  for (let i = 1; i <= 3; i += 1) $(`obStep${i}`).hidden = i !== step;
  const dots = $('obDots').children;
  for (let i = 0; i < dots.length; i += 1) dots[i].classList.toggle('on', i < step);
  const next = $('obNext');
  next.classList.remove('busy');
  next.hidden = false;
  next.disabled = false;
  $('obCancel').textContent = 'Cancel';
  if (step === 1) {
    next.textContent = 'Join network';
  } else if (step === 2) {
    $('obKeyValue').textContent = state.setupKey;
    next.textContent = 'I saved my key \u2014 continue';
  } else if (step === 3) {
    next.hidden = true;
    $('obCancel').textContent = 'Close';
    obStartJoining();
  }
}

async function obStartJoining() {
  const ssid = $('ob_ssid').value.trim();
  const hostname = state.status?.wifi?.hostname || 'streamline-xxxx.local';
  $('obJoinTitle').textContent = `Joining ${ssid}\u2026`;
  $('obAddress').textContent = `http://${hostname}/`;
  $('obProg').style.width = '0';
  $('obCountdown').textContent = 'Saving\u2026';

  const body = new URLSearchParams({
    ssid,
    password: $('ob_password').value,
    target_host: state.status?.target?.target_host || '',
    target_port: String(state.status?.target?.target_port || 39000),
    admin_secret: state.setupKey,
  });

  try {
    await api('/api/settings/network', { method: 'POST', body });
  } catch {
    // The device reboots immediately; the fetch typically fails.
  }

  unlockSettings(state.setupKey, $('obRememberKey').checked);
  beginRebootWait('the network settings');

  let remaining = 10;
  $('obCountdown').textContent = `Restarting \u2014 about ${remaining} s\u2026`;
  const iv = setInterval(() => {
    remaining -= 1;
    const pct = Math.min(100, ((10 - remaining) / 10) * 100);
    $('obProg').style.width = `${pct}%`;
    if (remaining > 0) {
      $('obCountdown').textContent = `Restarting \u2014 about ${remaining} s\u2026`;
    } else {
      clearInterval(iv);
      $('obProg').style.width = '100%';
      $('obCountdown').textContent =
        'Done \u2014 reconnect to your own Wi-Fi and open the address above.';
    }
  }, 1000);
}

$('obCancel').addEventListener('click', closeOnboarding);
$('obNext').addEventListener('click', () => {
  if (obStep === 1) {
    const ssid = $('ob_ssid').value.trim();
    const pass = $('ob_password').value;
    if (!ssid) {
      toast('Enter your Wi-Fi network name', 'err');
      return;
    }
    if (!pass) {
      toast('Enter the Wi-Fi password', 'err');
      return;
    }
    obShow(2);
  } else if (obStep === 2) {
    obShow(3);
  }
});
$('obCopyKey').addEventListener('click', () => {
  copySecret(state.setupKey).then(
    () => toast('Admin key copied', 'ok'),
    (err) => toast(err.message, 'err'),
  );
});

$('nameForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const button = submitButton(e);
  transact(button, () => api('/api/settings/name', { method: 'POST', body: formBody(e.target) }), {
    busyText: 'Saving…',
    okText: 'Saved',
  });
});

$('setupForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const button = submitButton(e);
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
      const data = await api('/api/settings/network', { method: 'POST', body: formBody(e.target) });
      if (firstSetup && state.setupKey) {
        // The device reboots onto the home network; keep the key so this
        // browser can unlock it there.
        unlockSettings(state.setupKey, $('rememberSetupKey').checked);
      }
      return data;
    },
    { busyText: 'Saving…', reboots: 'the network settings' },
  );
  if (firstSetup) {
    const hostname = state.status?.wifi?.hostname || 'streamline-xxxx.local';
    toast(
      `The setup network disappears now — reconnect to your own Wi-Fi, then open http://${hostname}/.`,
      'wait',
      0,
    );
  }
});

$('adminKeyForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const button = submitButton(e);
  transact(
    button,
    async () => {
      if (!isUnlocked()) throw new Error('unlock settings before replacing the admin key');
      if (!state.replacementKey) stageReplacementKey();
      await api('/api/settings/admin-key', { method: 'POST', body: formBody(e.target) });
      const remember = $('rememberReplacementKey').checked;
      unlockSettings(state.replacementKey, remember);
      // Refresh the unlock field so a later unlock shows the active key.
      $('unlockSecret').value = remember ? state.replacementKey : '';
      state.replacementKey = '';
      $('replacementKeyPanel').hidden = true;
      $('replaceKeyIntro').hidden = false;
    },
    { busyText: 'Saving…', okText: 'New key saved and active' },
  );
});

$('replaceKeyButton').addEventListener('click', () => {
  stageReplacementKey();
  $('replaceKeyIntro').hidden = true;
});

$('cancelReplaceKeyButton').addEventListener('click', () => {
  state.replacementKey = '';
  $('replacement_admin_secret').value = '';
  $('replacementKeyPanel').hidden = true;
  $('replaceKeyIntro').hidden = false;
  renderGating();
});

$('copyReplacementKeyButton').addEventListener('click', () => {
  copySecret(state.replacementKey).then(
    () => toast('New admin key copied', 'ok'),
    (err) => toast(err.message, 'err'),
  );
});

$('restartButton').addEventListener('click', () => {
  transact(
    $('restartButton'),
    async () => {
      await api('/api/restart', { method: 'POST' });
      beginRebootWait('the restart', 'Restarting — the console reconnects by itself');
    },
    { busyText: 'Restarting…', okText: 'Restarting — back in ~10 s' },
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
      const data = await api('/api/factory-reset', { method: 'POST' });
      $('factoryConfirm').hidden = true;
      return data;
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
  const button = submitButton(e);
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
