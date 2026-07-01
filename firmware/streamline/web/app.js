'use strict';

const ADMIN_KEY_STORAGE = 'streamline_admin_key';
const LEGACY_TOKEN_STORAGE = 'streamline_token';
const UNLOCK_UNTIL_STORAGE = 'streamline_unlock_until';
const UNLOCK_WINDOW_MS = 15 * 60 * 1000;

const $ = (id) => document.getElementById(id);
const msg = $('message');

let currentStatus = null;
let generatedSetupKey = '';
let replacementKey = '';

function setMsg(text, cls = '') {
  msg.textContent = text;
  msg.className = 'msg ' + cls;
}

function dbfs(abs) {
  if (!abs) return '-inf dBFS';
  return (20 * Math.log10(abs / 32768)).toFixed(1) + ' dBFS';
}

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

function storedAdminKey() {
  return sessionStorage.getItem(ADMIN_KEY_STORAGE) ||
    localStorage.getItem(ADMIN_KEY_STORAGE) ||
    localStorage.getItem(LEGACY_TOKEN_STORAGE) ||
    '';
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

async function api(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const headers = Object.assign({}, opts.headers);
  const key = storedAdminKey();
  if (method !== 'GET' && key && isUnlocked()) headers['Authorization'] = 'Bearer ' + key;
  const r = await fetch(path, Object.assign({}, opts, { headers }));
  const text = await r.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (e) {
    data = { message: text };
  }
  if (r.status === 401) {
    lockSettings(false);
    throw new Error('unauthorized — unlock settings with the admin key');
  }
  if (!r.ok) throw new Error(data.error || text || r.status);
  return data;
}

function applyStatus(s) {
  currentStatus = s;
  $('subtitle').textContent =
    'v' + s.firmware_version + ' / ' + s.audio.sample_rate + ' Hz / ' +
    s.audio.channels + ' ch / ' + s.audio.bits_per_sample + ' bit';
  $('mode').textContent = s.mode;
  $('playing').textContent = s.metrics.playing ? 'yes' : 'no';
  setMetricClass($('playingMetric'), s.metrics.playing);
  $('staIp').textContent = s.wifi.sta_ip;
  $('targetAddr').textContent = s.target.target_host + ':' + s.target.target_port;
  $('clipsLast').textContent = s.metrics.clipped_samples_total;
  $('peakLR').textContent = dbfs(s.metrics.peak_abs_left) + ' / ' + dbfs(s.metrics.peak_abs_right);
  $('rmsLR').textContent = dbfs(s.metrics.rms_left) + ' / ' + dbfs(s.metrics.rms_right);
  $('rssi').textContent = s.wifi.rssi + ' dBm';
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
    ['ADC Attenuation', s.audio.adc_atten_db + ' dB'],
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

// --- Firmware update -------------------------------------------------------

const PHASE_LABELS = {
  'idle': 'Idle',
  'checking': 'Checking…',
  'up-to-date': 'Up to date',
  'update-available': 'Update available',
  'downloading': 'Downloading…',
  'verifying': 'Verifying…',
  'installed': 'Installed',
  'failed': 'Failed',
};

let otaLatest = '';
let otaLoggedPhase = null;

function prettyPhase(p) {
  return PHASE_LABELS[p] || p;
}

function logOta(line, cls = '') {
  const el = $('otaLog');
  el.querySelectorAll('.dim').forEach((n) => n.remove());
  const row = document.createElement('div');
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = new Date().toLocaleTimeString() + '  ';
  const m = document.createElement('span');
  if (cls) m.className = cls;
  m.textContent = line;
  row.append(t, m);
  el.append(row);
  el.scrollTop = el.scrollHeight;
}

function beginOtaSession(line) {
  $('otaLog').innerHTML = '';
  otaLoggedPhase = null;
  logOta(line);
}

function applyOta(current, o) {
  if (!o) return;
  otaLatest = o.latest_version || '';

  const rows = [
    ['Current', 'v' + current],
    ['Latest', otaLatest ? 'v' + otaLatest : '—'],
    ['Status', prettyPhase(o.phase)],
  ];
  if (o.phase === 'downloading' && o.bytes_total) {
    rows.push(['Progress', Math.round(100 * o.bytes_written / o.bytes_total) + '%']);
  }
  kv($('otaKv'), rows);

  $('checkButton').disabled = o.busy;
  const install = $('installButton');
  if (o.phase === 'update-available') {
    install.hidden = false;
    install.disabled = o.busy;
    install.textContent = 'Install v' + otaLatest;
  } else if (o.phase === 'downloading' || o.phase === 'verifying' || o.phase === 'installed') {
    install.hidden = false;
    install.disabled = true;
    install.textContent = 'Installing…';
  } else {
    install.hidden = true;
  }

  // Append a line to the activity log whenever the phase advances. Transient
  // sub-states share a phase, so this stays quiet.
  if (o.phase !== 'idle' && o.phase !== otaLoggedPhase) {
    otaLoggedPhase = o.phase;
    let line = prettyPhase(o.phase);
    const detailed = o.phase === 'up-to-date' || o.phase === 'update-available' ||
                     o.phase === 'installed' || o.phase === 'failed';
    if (detailed && o.message) line += ' — ' + o.message;
    logOta(line, o.phase === 'failed' ? 'err' : (o.phase === 'installed' ? 'ok' : ''));
  }
}

function setDisabled(selector, disabled) {
  document.querySelectorAll(selector).forEach((el) => {
    el.disabled = disabled;
    el.title = disabled ? 'Unlock settings with the admin key' : '';
  });
}

function settingsWritable() {
  if (!currentStatus) return false;
  if (currentStatus.configuration_writable === false) return false;
  return !currentStatus.auth_required || isUnlocked();
}

function setProtectedControls() {
  const writable = settingsWritable();
  setDisabled('#setupForm input:not([type="hidden"]),#setupForm button,#audioForm input,#audioForm select,#audioForm button,#resetButton,#checkButton,#installButton', !writable);
  setDisabled('#adminKeyForm input,#adminKeyForm button', !(currentStatus && currentStatus.auth_required && isUnlocked()));
  $('copyReplacementKeyButton').disabled = !replacementKey || !(currentStatus && currentStatus.auth_required && isUnlocked());
}

function ensureSetupKey() {
  if (!generatedSetupKey) generatedSetupKey = generateAdminKey();
  $('admin_secret').value = generatedSetupKey;
  $('setupKeyValue').textContent = generatedSetupKey;
  $('setupKeyPanel').hidden = false;
}

function clearSetupKey() {
  generatedSetupKey = '';
  $('admin_secret').value = '';
  $('setupKeyValue').textContent = '';
  $('setupKeyPanel').hidden = true;
}

function updateAuthUi() {
  const state = $('authState');
  if (!currentStatus) {
    state.textContent = 'Auth: checking';
    state.className = 'authState';
    $('unlockSecret').hidden = true;
    $('rememberKeyLabel').hidden = true;
    $('unlockButton').hidden = true;
    $('lockButton').hidden = true;
    return;
  }

  if (!currentStatus.auth_required) {
    ensureSetupKey();
    state.textContent = 'Auth: setup mode';
    state.className = 'authState unlocked';
    $('unlockSecret').hidden = true;
    $('rememberKeyLabel').hidden = true;
    $('unlockButton').hidden = true;
    $('lockButton').hidden = true;
    return;
  }

  clearSetupKey();
  if (isUnlocked()) {
    const until = new Date(unlockUntil()).toLocaleTimeString();
    state.textContent = 'Auth: unlocked until ' + until;
    state.className = 'authState unlocked';
    $('unlockSecret').hidden = true;
    $('rememberKeyLabel').hidden = true;
    $('unlockButton').hidden = true;
    $('lockButton').hidden = false;
  } else {
    const key = storedAdminKey();
    state.textContent = key ? 'Auth: locked, key saved' : 'Auth: locked';
    state.className = 'authState locked';
    $('unlockSecret').hidden = false;
    $('unlockSecret').value = key;
    $('rememberKeyLabel').hidden = false;
    $('rememberKey').checked = Boolean(localStorage.getItem(ADMIN_KEY_STORAGE));
    $('unlockButton').hidden = false;
    $('lockButton').hidden = true;
  }
}

async function refresh() {
  try {
    applyStatus(await api('/api/status'));
  } catch (e) {
    setMsg(e.message, 'err');
  }
}

async function loadConfig() {
  const c = await api('/api/config');
  $('ssid').value = c.ssid;
  $('target_host').value = c.target_host;
  $('target_port').value = c.target_port;
  $('input_line').value = c.input_line;
  $('input_gain').value = c.input_gain;
  $('adc_atten_db').value = c.adc_atten_db;
}

function formBody(form) {
  return new URLSearchParams(new FormData(form));
}

function validateSetup() {
  const host = $('target_host').value.trim();
  if (host.includes(':') || host.includes('/')) {
    throw new Error('TCP target host must not include port, scheme, or path');
  }
  if (currentStatus && !currentStatus.auth_required) ensureSetupKey();
}

document.querySelectorAll('.tab').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.tab,.section').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $(b.dataset.tab).classList.add('active');
  })
);

$('unlockButton').addEventListener('click', () => {
  const key = $('unlockSecret').value.trim();
  if (key.length < 8) {
    setMsg('admin key must be at least 8 characters', 'err');
    return;
  }
  unlockSettings(key, $('rememberKey').checked);
  setMsg('');
});

$('lockButton').addEventListener('click', () => lockSettings(false));

$('copySetupKeyButton').addEventListener('click', async () => {
  try {
    await copySecret(generatedSetupKey);
    setMsg('admin key copied', 'ok');
  } catch (err) {
    setMsg(err.message, 'err');
  }
});

$('generateReplacementKeyButton').addEventListener('click', () => {
  try {
    replacementKey = generateAdminKey();
    $('replacement_admin_secret').value = replacementKey;
    $('replacementKeyValue').textContent = replacementKey;
    $('replacementKeyPanel').hidden = false;
    setProtectedControls();
  } catch (err) {
    setMsg(err.message, 'err');
  }
});

$('copyReplacementKeyButton').addEventListener('click', async () => {
  try {
    await copySecret(replacementKey);
    setMsg('new admin key copied', 'ok');
  } catch (err) {
    setMsg(err.message, 'err');
  }
});

$('setupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    validateSetup();
    await api('/api/setup', { method: 'POST', body: formBody(e.target) });
    setMsg('setup saved; rebooting', 'ok');
  } catch (err) {
    setMsg(err.message, 'err');
  }
});

$('adminKeyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    if (!isUnlocked()) throw new Error('unlock settings before replacing the admin key');
    if (!replacementKey) {
      replacementKey = generateAdminKey();
      $('replacement_admin_secret').value = replacementKey;
      $('replacementKeyValue').textContent = replacementKey;
      $('replacementKeyPanel').hidden = false;
    }
    await api('/api/admin-key', { method: 'POST', body: formBody(e.target) });
    unlockSettings(replacementKey, $('rememberReplacementKey').checked);
    setMsg('admin key saved', 'ok');
  } catch (err) {
    setMsg(err.message, 'err');
  }
});

$('audioForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/audio', { method: 'POST', body: formBody(e.target) });
    setMsg('audio saved; rebooting', 'ok');
  } catch (err) {
    setMsg(err.message, 'err');
  }
});

$('resetButton').addEventListener('click', async () => {
  if (!confirm('Clear saved config and reboot?')) return;
  try {
    await api('/api/reset', { method: 'POST' });
    setMsg('config cleared; rebooting', 'ok');
  } catch (err) {
    setMsg(err.message, 'err');
  }
});

$('checkButton').addEventListener('click', async () => {
  beginOtaSession('Checking GitHub for a newer release…');
  try {
    await api('/api/ota/check', { method: 'POST' });
  } catch (err) {
    logOta(err.message, 'err');
  }
});

$('installButton').addEventListener('click', async () => {
  const target = otaLatest ? 'v' + otaLatest : 'the latest release';
  if (!confirm('Install ' + target + ' and reboot the device?')) return;
  beginOtaSession('Installing ' + target + '…');
  try {
    await api('/api/ota/update', { method: 'POST' });
  } catch (err) {
    logOta(err.message, 'err');
  }
});

Promise.all([loadConfig(), refresh()]).catch((e) => setMsg(e.message, 'err'));
setInterval(refresh, 1500);
