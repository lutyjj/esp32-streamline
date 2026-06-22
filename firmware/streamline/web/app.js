'use strict';

const $ = (id) => document.getElementById(id);
const msg = $('message');

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

function token() {
  return localStorage.getItem('streamline_token') || '';
}

async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers);
  const t = token();
  if (t) headers['Authorization'] = 'Bearer ' + t;
  const r = await fetch(path, Object.assign({}, opts, { headers }));
  const text = await r.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (e) {
    data = { message: text };
  }
  if (r.status === 401) throw new Error('unauthorized — set the console token');
  if (!r.ok) throw new Error(data.error || text || r.status);
  return data;
}

function applyStatus(s) {
  $('subtitle').textContent =
    'v' + s.firmware_version + ' / ' + s.audio.sample_rate + ' Hz / ' +
    s.audio.channels + ' ch / ' + s.audio.bits_per_sample + ' bit';
  $('mode').textContent = s.mode;
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
  setConfigWritable(s.configuration_writable);
  applyOta(s.firmware_version, s.ota);
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
  // sub-states (clock sync, header read) share a phase, so this stays quiet.
  if (o.phase !== 'idle' && o.phase !== otaLoggedPhase) {
    otaLoggedPhase = o.phase;
    let line = prettyPhase(o.phase);
    const detailed = o.phase === 'up-to-date' || o.phase === 'update-available' ||
                     o.phase === 'installed' || o.phase === 'failed';
    if (detailed && o.message) line += ' — ' + o.message;
    logOta(line, o.phase === 'failed' ? 'err' : (o.phase === 'installed' ? 'ok' : ''));
  }
}

function setConfigWritable(writable) {
  document.querySelectorAll('#setupForm input,#setupForm button').forEach((el) => {
    el.disabled = !writable;
    el.title = writable ? '' : 'Wi-Fi and target are writable only in setup mode';
  });
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
}

document.querySelectorAll('.tab').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.tab,.section').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $(b.dataset.tab).classList.add('active');
  })
);

$('setupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    validateSetup();
    await api('/api/setup', { method: 'POST', body: formBody(e.target) });
    const s = $('admin_secret').value.trim();
    if (s) {
      localStorage.setItem('streamline_token', s);
      tokenInput.value = s;
    }
    setMsg('setup saved; rebooting', 'ok');
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

const tokenInput = $('token');
tokenInput.value = token();
tokenInput.addEventListener('change', () =>
  localStorage.setItem('streamline_token', tokenInput.value.trim())
);

loadConfig().then(refresh).catch((e) => setMsg(e.message, 'err'));
setInterval(refresh, 1500);
