import { useEffect, useState } from 'preact/hooks';
import { generateAdminKey, isUnlocked, replaceAdminKey, useAuthEpoch } from '../lib/adminKey';
import {
  type DeviceConfig,
  factoryReset,
  otaCheck,
  otaRollback,
  otaUpdate,
  restart as restartDevice,
  setAdminKey,
  setName as setDeviceName,
  setFirmware,
} from '../lib/api';
import { useTransact, useWritable } from '../lib/hooks';
import { config, status } from '../state/device';
import { beginOtaSession, OTA_INSTALLING_PHASES, otaLog, prettyPhase } from '../state/ota';
import { Button } from './Button';
import { Card, CardFooter } from './Card';
import { ConfirmButton } from './ConfirmButton';
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
  const settingsTransact = useTransact();
  const customTransact = useTransact();
  const [autoUpdateSchedule, setAutoUpdateSchedule] =
    useState<DeviceConfig['auto_update_schedule']>('daily');
  const [url, setUrl] = useState('');
  const [sha256, setSha256] = useState('');

  const c = config.value;
  useEffect(() => {
    if (c) setAutoUpdateSchedule(c.auto_update_schedule);
  }, [c]);

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

  const installing = OTA_INSTALLING_PHASES.includes(ota?.phase ?? '');

  return (
    <Card
      gated
      title="Firmware"
      lead="Choose how often the device checks for a new release. It waits for idle audio, then uses the same verified, rollback-safe flow as a manual update."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          settingsTransact.run(
            async () => {
              const data = await setFirmware({ auto_update_schedule: autoUpdateSchedule });
              if (config.value) {
                config.value = { ...config.value, auto_update_schedule: autoUpdateSchedule };
              }
              return data;
            },
            { busyText: 'Saving…', okText: 'Update preference saved' },
          );
        }}
      >
        <div class="field field-narrow card-section">
          <label for="auto_update_schedule">Automatic updates</label>
          <select
            id="auto_update_schedule"
            disabled={!writable}
            value={autoUpdateSchedule}
            onChange={(e) =>
              setAutoUpdateSchedule(e.currentTarget.value as DeviceConfig['auto_update_schedule'])
            }
          >
            <option value="daily">Daily when idle</option>
            <option value="weekly">Weekly when idle</option>
            <option value="disabled">Off</option>
          </select>
          <span class="help">The first check waits ten minutes after startup.</span>
        </div>
        <CardFooter>
          <TransactButton transact={settingsTransact} type="submit" disabled={!writable}>
            Save
          </TransactButton>
          <ActionState state={settingsTransact.state} />
        </CardFooter>
      </form>
      <div class="formgrid card-section">
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
      <CardFooter>
        <TransactButton
          transact={transact}
          kind="secondary"
          disabled={!writable || ota?.busy}
          onClick={() => {
            beginOtaSession('Checking GitHub for a newer release…');
            transact.run(() => otaCheck(), {
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
              transact.run(() => otaUpdate({}), {
                busyText: 'Installing…',
                okText: 'Install started — progress below',
              });
            }}
          >
            Install v{latest}
          </TransactButton>
        )}
        {installing && (
          <Button kind="primary" disabled>
            Installing
          </Button>
        )}
        {ota?.rollback_available && !installing && (
          <TransactButton
            transact={transact}
            kind="secondary"
            disabled={!writable || ota.busy}
            onClick={() => {
              const target = ota.rollback_version
                ? `v${ota.rollback_version}`
                : 'the previous version';
              beginOtaSession(`Rolling back to ${target}…`);
              transact.run(() => otaRollback(), {
                busyText: 'Rolling back…',
                reboots: 'the rollback',
              });
            }}
          >
            {ota.rollback_version ? `Roll back to v${ota.rollback_version}` : 'Roll back'}
          </TransactButton>
        )}
        <ActionState state={transact.state} />
      </CardFooter>
      <Disclosure title="Developer — install a custom image" className="disclosure-offset">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            beginOtaSession(`Installing custom image from ${url.trim()}…`);
            customTransact.run(() => otaUpdate({ url: url.trim(), sha256: sha256.trim() }), {
              busyText: 'Installing…',
              okText: 'Install started — progress below',
            });
          }}
        >
          <div class="formgrid card-section">
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
          <CardFooter>
            <TransactButton
              transact={customTransact}
              kind="secondary"
              type="submit"
              disabled={!writable}
            >
              Install custom image
            </TransactButton>
            <ActionState state={customTransact.state} />
          </CardFooter>
        </form>
      </Disclosure>
    </Card>
  );
}

function NameCard() {
  const writable = useWritable();
  const transact = useTransact();
  const [name, setName] = useState('');

  // Seed from each settings snapshot, like every other form (initial load
  // and after expected reboots).
  const c = config.value;
  useEffect(() => {
    if (c) setName(c.device_name);
  }, [c]);

  return (
    <Card
      gated
      title="Device name"
      lead="Shown in the console header and browser tab so you can tell devices apart."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          transact.run(() => setDeviceName({ name }), {
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
        <CardFooter>
          <TransactButton transact={transact} type="submit" disabled={!writable}>
            Save
          </TransactButton>
          <ActionState state={transact.state} />
        </CardFooter>
      </form>
    </Card>
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
      async () => {
        const ack = await replaceAdminKey(
          (secret) => setAdminKey({ admin_secret: secret }),
          staged,
          remember,
        );
        setStaged('');
        return ack;
      },
      { busyText: 'Saving…', okText: 'New key saved and active' },
    );
  }

  return (
    <Card
      gated
      title="Access"
      lead="One admin key protects every change. Reads are open on your network; unlocking lasts 15 minutes."
    >
      <form onSubmit={save}>
        {!staged && (
          <CardFooter>
            <Button disabled={!manageable} onClick={() => setStaged(generateAdminKey())}>
              Replace admin key
            </Button>
            <span class="actionstate">The new key is shown once before it takes effect.</span>
          </CardFooter>
        )}
        {staged && (
          <div class="keypanel">
            <p>
              <strong class="strong">Your new admin key.</strong> Copy it before saving. it is shown
              only this once.
            </p>
            <KeyReveal
              secret={staged}
              remember={remember}
              onRemember={setRemember}
              disabled={!manageable}
              copiedToast="New admin key copied"
            />
            <CardFooter>
              <TransactButton transact={transact} type="submit" disabled={!manageable}>
                Save
              </TransactButton>
              <Button disabled={!manageable} onClick={() => setStaged('')}>
                Cancel
              </Button>
              <ActionState state={transact.state} />
            </CardFooter>
          </div>
        )}
      </form>
    </Card>
  );
}

function ResetCard() {
  const writable = useWritable();
  const restart = useTransact();
  const factory = useTransact();

  return (
    <Card gated title="Reset">
      <CardFooter compact>
        <TransactButton
          transact={restart}
          kind="secondary"
          disabled={!writable}
          onClick={() =>
            restart.run(() => restartDevice(), {
              busyText: 'Restarting…',
              reboots: 'the restart',
            })
          }
        >
          Restart device
        </TransactButton>
        <ConfirmButton
          label="Factory reset"
          confirmLabel="Erase everything"
          disabled={!writable}
          message="This erases Wi-Fi, the stream target, audio settings and profiles, and the admin key. The device returns to its setup network."
          onConfirm={() =>
            factory.run(() => factoryReset(), {
              busyText: 'Erasing…',
              reboots: 'the factory reset',
            })
          }
        />
        <ActionState state={factory.state} />
      </CardFooter>
    </Card>
  );
}

function RawStatusCard() {
  return (
    <Card>
      <Disclosure title="Developer — raw status">
        <div class="log apidump card-section">{JSON.stringify(status.value, null, 2)}</div>
        <CardFooter compact>
          <span class="actionstate">
            Full JSON at <code>/api/status</code> · Prometheus at <code>/api/metrics</code>
          </span>
        </CardFooter>
      </Disclosure>
    </Card>
  );
}
