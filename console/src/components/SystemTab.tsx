import { useState } from 'preact/hooks';
import { generateAdminKey, isUnlocked, unlockSettings, useAuthEpoch } from '../lib/adminKey';
import { api, postForm } from '../lib/api';
import { useTransact, useWritable } from '../lib/hooks';
import { config, status } from '../state/device';
import { beginOtaSession, otaLog, prettyPhase } from '../state/ota';
import { beginRebootWait } from '../state/rebootWait';
import { Disclosure } from './Disclosure';
import { KeyReveal } from './KeyReveal';
import { Kv } from './Kv';
import { ActionState, TransactButton } from './Transact';

export function SystemTab() {
  return (
    <>
      <FirmwareCard />
      <NameCard />
      <AccessCard />
      <ResetCard />
      <RawStatusCard />
    </>
  );
}

function FirmwareCard() {
  const writable = useWritable();
  const s = status.value;
  const ota = s?.ota;
  const transact = useTransact();
  const customTransact = useTransact();
  const [url, setUrl] = useState('');
  const [sha256, setSha256] = useState('');

  const latest = ota?.latest_version || '';
  const rows: [string, string][] = [
    ['Installed', `v${s?.firmware_version ?? '—'}`],
    ['Latest release', latest ? `v${latest}` : '—'],
    ['Status', ota ? prettyPhase(ota.phase) : '—'],
    ...(ota?.phase === 'downloading' && ota.bytes_total
      ? [
          ['Progress', `${Math.round((100 * ota.bytes_written) / ota.bytes_total)}%`] as [
            string,
            string,
          ],
        ]
      : []),
  ];

  const installing = ['downloading', 'verifying', 'installed'].includes(ota?.phase ?? '');

  return (
    <div class="card gated">
      <span class="lockhint">Unlock to edit</span>
      <h2>Firmware</h2>
      <div class="formgrid" style="margin-top:12px">
        <Kv rows={rows} />
        <div class="log">
          {otaLog.value.length === 0 && (
            <span class="dim">
              No update activity yet. Check compares against the latest GitHub release.
            </span>
          )}
          {otaLog.value.map((line, i) => (
            <div key={i}>
              <span class="t">{line.at} </span>
              <span class={line.cls}>{line.text}</span>
            </div>
          ))}
        </div>
      </div>
      <div class="cardfoot">
        <TransactButton
          transact={transact}
          kind="secondary"
          disabled={!writable || ota?.busy}
          onClick={() => {
            beginOtaSession('Checking GitHub for a newer release…');
            transact.run(() => api('/api/ota/check', { method: 'POST' }), {
              busyText: 'Checking…',
              okText: '',
            });
          }}
        >
          Check for update
        </TransactButton>
        {ota?.phase === 'update-available' && (
          <TransactButton
            transact={transact}
            disabled={!writable || ota.busy}
            onClick={() => {
              beginOtaSession(`Installing ${latest ? `v${latest}` : 'the latest release'}…`);
              transact.run(() => api('/api/ota/update', { method: 'POST' }), {
                busyText: 'Installing…',
                okText: 'Install started — progress below',
              });
            }}
          >
            Install v{latest}
          </TransactButton>
        )}
        {installing && (
          <button class="btn primary" type="button" disabled>
            Installing
          </button>
        )}
        <ActionState state={transact.state} />
      </div>
      <Disclosure title="Developer — install a custom image" className="disclosure-offset">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            beginOtaSession(`Installing custom image from ${url.trim()}…`);
            customTransact.run(
              () => postForm('/api/ota/update', { url: url.trim(), sha256: sha256.trim() }),
              { busyText: 'Installing…', okText: 'Install started — progress below' },
            );
          }}
        >
          <div class="formgrid" style="margin-top:12px">
            <div class="field">
              <label for="ota_url">Image URL</label>
              <input
                id="ota_url"
                type="text"
                autocomplete="off"
                placeholder="http://host:8000/streamline-ota.bin"
                disabled={!writable}
                value={url}
                onInput={(e) => setUrl(e.currentTarget.value)}
              />
            </div>
            <div class="field">
              <label for="ota_sha256">SHA-256</label>
              <input
                id="ota_sha256"
                type="text"
                autocomplete="off"
                placeholder="64 hex characters — pins the image"
                disabled={!writable}
                value={sha256}
                onInput={(e) => setSha256(e.currentTarget.value)}
              />
            </div>
          </div>
          <div class="cardfoot">
            <TransactButton
              transact={customTransact}
              kind="secondary"
              type="submit"
              disabled={!writable}
            >
              Install custom image
            </TransactButton>
            <ActionState state={customTransact.state} />
          </div>
        </form>
      </Disclosure>
    </div>
  );
}

function NameCard() {
  const writable = useWritable();
  const transact = useTransact();
  const [name, setName] = useState(config.value?.device_name ?? '');
  const [seeded, setSeeded] = useState(false);
  if (!seeded && config.value) {
    setName(config.value.device_name);
    setSeeded(true);
  }

  return (
    <div class="card gated">
      <span class="lockhint">Unlock to edit</span>
      <h2>Device name</h2>
      <p class="lead">Shown in the console header and browser tab so you can tell devices apart.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          transact.run(() => postForm('/api/settings/name', { name }), {
            busyText: 'Saving…',
            okText: 'Saved',
          });
        }}
      >
        <div class="formgrid">
          <div class="field">
            <label for="device_name">Name</label>
            <input
              id="device_name"
              type="text"
              autocomplete="off"
              maxlength={32}
              placeholder="e.g. Study CD player"
              disabled={!writable}
              value={name}
              onInput={(e) => setName(e.currentTarget.value)}
            />
            <span class="help">Leave blank to show only the address.</span>
          </div>
        </div>
        <div class="cardfoot">
          <TransactButton transact={transact} type="submit" disabled={!writable}>
            Save
          </TransactButton>
          <ActionState state={transact.state} />
        </div>
      </form>
    </div>
  );
}

function AccessCard() {
  useAuthEpoch();
  const transact = useTransact();
  // Staging a replacement key requires an open unlock window, like every write.
  const manageable = Boolean(status.value?.auth_required && isUnlocked());
  const [staged, setStaged] = useState('');
  const [remember, setRemember] = useState(true);

  function save(e: SubmitEvent) {
    e.preventDefault();
    transact.run(
      async (): Promise<undefined> => {
        if (!isUnlocked()) throw new Error('unlock settings before replacing the admin key');
        await postForm('/api/settings/admin-key', { admin_secret: staged });
        unlockSettings(staged, remember);
        setStaged('');
        return undefined;
      },
      { busyText: 'Saving…', okText: 'New key saved and active' },
    );
  }

  return (
    <div class="card gated">
      <span class="lockhint">Unlock to edit</span>
      <h2>Access</h2>
      <p class="lead">
        One admin key protects every change. Reads are open on your network; unlocking lasts 15
        minutes.
      </p>
      <form onSubmit={save}>
        {!staged && (
          <div class="cardfoot" style="border:0;padding:0;margin-top:12px">
            <button
              class="btn secondary"
              type="button"
              disabled={!manageable}
              onClick={() => setStaged(generateAdminKey())}
            >
              Replace admin key
            </button>
            <span class="actionstate">The new key is shown once before it takes effect.</span>
          </div>
        )}
        {staged && (
          <div class="keypanel">
            <p>
              <strong style="color:var(--text)">Your new admin key.</strong> Copy it before saving —
              it is shown only this once.
            </p>
            <KeyReveal
              secret={staged}
              remember={remember}
              onRemember={setRemember}
              disabled={!manageable}
              copiedToast="New admin key copied"
            />
            <div class="cardfoot">
              <TransactButton transact={transact} type="submit" disabled={!manageable}>
                Save
              </TransactButton>
              <button
                class="btn secondary"
                type="button"
                disabled={!manageable}
                onClick={() => setStaged('')}
              >
                Cancel
              </button>
              <ActionState state={transact.state} />
            </div>
          </div>
        )}
      </form>
    </div>
  );
}

function ResetCard() {
  const writable = useWritable();
  const restart = useTransact();
  const factory = useTransact();
  const [confirming, setConfirming] = useState(false);

  return (
    <div class="card gated">
      <span class="lockhint">Unlock to edit</span>
      <h2>Reset</h2>
      <div class="cardfoot" style="border:0;padding:0;margin-top:10px">
        <TransactButton
          transact={restart}
          kind="secondary"
          disabled={!writable}
          onClick={() =>
            restart.run(
              async (): Promise<undefined> => {
                await api('/api/restart', { method: 'POST' });
                beginRebootWait('the restart', 'Restarting — the console reconnects by itself');
                return undefined;
              },
              { busyText: 'Restarting…', okText: 'Restarting — back in ~10 s' },
            )
          }
        >
          Restart device
        </TransactButton>
        <button
          class="btn danger"
          type="button"
          disabled={!writable}
          onClick={() => setConfirming(true)}
        >
          Factory reset
        </button>
        <ActionState state={factory.state} />
      </div>
      {confirming && (
        <div class="confirmbox">
          <span>
            This erases Wi-Fi, the stream target, audio settings, and the admin key. The device
            returns to its setup network.
          </span>
          <div class="row">
            <TransactButton
              transact={factory}
              kind="danger"
              disabled={!writable}
              onClick={() =>
                factory.run(
                  async () => {
                    const data = await api<{ rebooting?: boolean }>('/api/factory-reset', {
                      method: 'POST',
                    });
                    setConfirming(false);
                    return data;
                  },
                  { busyText: 'Erasing…', reboots: 'the factory reset' },
                )
              }
            >
              Erase everything
            </TransactButton>
            <button class="btn secondary" type="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RawStatusCard() {
  return (
    <div class="card">
      <Disclosure title="Developer — raw status">
        <div class="log apidump" style="margin-top:12px">
          {JSON.stringify(status.value, null, 2)}
        </div>
        <div class="cardfoot" style="border:0;padding:6px 0 0">
          <span class="actionstate">
            Full JSON at <code>/api/status</code> · Prometheus at <code>/api/metrics</code>
          </span>
        </div>
      </Disclosure>
    </div>
  );
}
