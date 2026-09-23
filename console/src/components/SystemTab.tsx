import { sectionFromHash, useRouteHash } from '../state/route';
import './system.css';
import { useState } from 'preact/hooks';
import { generateAdminKey, isUnlocked, replaceAdminKey, useAuthEpoch } from '../lib/adminKey';
import {
  factoryReset,
  otaCheck,
  otaRollback,
  otaUpdate,
  restart as restartDevice,
  type SettingsResponse,
  setAdminKey,
  setName as setDeviceName,
  setFirmware,
} from '../lib/api';
import { bytes, duration } from '../lib/format';
import { useDeviceField, useTransact, useWritable } from '../lib/hooks';
import { ApiError } from '../lib/http';
import { config, configResource, loadConfig, status } from '../state/device';
import {
  beginOtaSession,
  customImageProblem,
  OTA_INSTALLING_PHASES,
  otaLog,
  prettyPhase,
} from '../state/ota';
import { beginResetHandoff, resetHandoff, resetHandoffMessage } from '../state/resetHandoff';
import { ApiTab } from './ApiTab';
import { Button } from './Button';
import { ButtonControls } from './ButtonControls';
import { ConfirmButton } from './ConfirmButton';
import { Disclosure } from './Disclosure';
import { KeyReveal } from './KeyReveal';
import { Kv } from './Kv';
import { LedControls } from './LedControls';
import { LogCard } from './LogCard';
import { NetworkTab } from './NetworkTab';
import { Notice } from './Notice';
import { ResourceNotice } from './ResourceNotice';
import { Section, SectionActions } from './Section';
import { SettingRow } from './SettingRow';
import { SettingsWorkspace } from './SettingsWorkspace';
import { ActionState, TransactButton } from './Transact';
import { UsageBar } from './UsageBar';

export function SystemTab({ onSetupBridge }: { onSetupBridge: () => void }) {
  const route = useRouteHash();
  return (
    <>
      <ResourceNotice of={configResource} />
      <SettingsWorkspace
        baseHref="#/settings"
        selected={sectionFromHash(route, 'settings')}
        label="Device settings"
        sections={[
          {
            id: 'bridge',
            label: 'Connect a player',
            description: 'Bridge address and audio destination',
            content: <NetworkTab section="bridge" onSetupBridge={onSetupBridge} />,
          },
          {
            id: 'wifi',
            label: 'Wi-Fi',
            description: 'Home network and connection recovery',
            content: <NetworkTab section="wifi" onSetupBridge={onSetupBridge} />,
          },
          {
            id: 'security',
            label: 'Encrypted audio',
            description: 'Protect the connection to your bridge',
            content: <NetworkTab section="security" onSetupBridge={onSetupBridge} />,
          },
          {
            id: 'identity',
            label: 'Device',
            description: 'Name, lights, and physical buttons',
            content: (
              <>
                <NameCard />
                <LedCard />
                <ButtonsCard />
              </>
            ),
          },
          {
            id: 'access',
            label: 'Access',
            description: 'Your device admin key',
            content: <AccessCard />,
          },
          {
            id: 'firmware',
            label: 'Updates',
            description: 'Firmware and automatic updates',
            content: <FirmwareCard />,
          },
          {
            id: 'maintenance',
            label: 'Restart & reset',
            description: 'Restart the device or begin setup again',
            content: <ResetCard />,
          },
          {
            id: 'diagnostics',
            label: 'Troubleshooting',
            description: 'Device health and logs',
            content: (
              <>
                <DeviceHealthCard />
                <LogCard />
                <RawStatusCard />
              </>
            ),
          },
          {
            id: 'api',
            label: 'Developer API',
            description: 'HTTP endpoints and request examples',
            content: <ApiTab />,
          },
        ]}
      />
    </>
  );
}

function LedCard() {
  const writable = useWritable();
  const s = status.value;
  const c = config.value;
  if (!s || !c) return null;
  return (
    <LedControls
      leds={s.capabilities.leds}
      roles={c.led_roles}
      writable={writable}
      provisioned={s.mode !== 'setup'}
    />
  );
}

function ButtonsCard() {
  const writable = useWritable();
  const s = status.value;
  const c = config.value;
  if (!s || !c) return null;
  return (
    <ButtonControls
      buttons={s.capabilities.buttons}
      actions={c.button_actions}
      writable={writable}
      provisioned={s.mode !== 'setup'}
    />
  );
}

function DeviceHealthCard() {
  const s = status.value;
  const sys = s?.system;
  if (!sys) return null;

  const { heap, nvs } = sys;
  const heapUsed = heap.total_bytes - heap.free_bytes;
  const bootReason = s?.diagnostics?.reset_reason || '—';

  const details: [string, string][] = [
    ['Largest free block', bytes(heap.largest_free_block_bytes)],
    ['Tasks running', String(sys.task_count)],
  ];

  return (
    <Section
      title="Device health"
      lead="Memory, saved configuration, and the last restart. Use these readings when investigating a fault."
    >
      <div class="section-body">
        <Kv
          rows={[
            ['Running for', duration(sys.uptime_seconds)],
            ['Last restart', bootReason],
            ...details,
          ]}
        />
      </div>
      <div class="resource-grid">
        <UsageBar
          label="Memory"
          value={heapUsed}
          max={heap.total_bytes}
          valueLabel={`${bytes(heap.free_bytes)} free`}
          caption={`${bytes(heapUsed)} used of ${bytes(heap.total_bytes)} · low-water ${bytes(heap.minimum_free_bytes)}`}
        />
        <UsageBar
          label="Storage (NVS)"
          value={nvs.used_entries}
          max={nvs.total_entries}
          valueLabel={`${nvs.available_entries} free`}
          caption={`${nvs.used_entries} of ${nvs.total_entries} config entries used`}
        />
      </div>
    </Section>
  );
}

function FirmwareCard() {
  const writable = useWritable();
  const s = status.value;
  const ota = s?.ota;
  const transact = useTransact();
  const settingsTransact = useTransact();
  const customTransact = useTransact();
  const schedule = useDeviceField(config.value?.auto_update_schedule ?? null);
  const [url, setUrl] = useState('');
  const [sha256, setSha256] = useState('');

  const latest = ota?.latest_version || '';
  const rows: [string, string][] = [
    ['Installed', `v${s?.firmware_version ?? '—'}`],
    ['Build', s?.firmware_variant ?? '—'],
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
    <Section
      gated
      title="Firmware updates"
      lead="Check your installed version and update when you are ready. Installation interrupts streaming."
    >
      <div class="formgrid section-body">
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
      <SectionActions>
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
      </SectionActions>
      <div class="update-schedule">
        <h3>Automatic updates</h3>
        <p class="help">
          Check daily or weekly after startup. Installation waits until audio is idle.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            settingsTransact.run(
              async () => {
                const value = schedule.value;
                if (value !== 'daily' && value !== 'weekly' && value !== 'disabled') {
                  throw new Error('Choose an automatic update schedule.');
                }
                const data = await setFirmware({ auto_update_schedule: value });
                if (config.value) {
                  config.value = { ...config.value, auto_update_schedule: value };
                }
                schedule.commit();
                return data;
              },
              { busyText: 'Saving…', okText: 'Update preference saved' },
            );
          }}
        >
          <div class="field field-narrow section-body">
            <label for="auto_update_schedule">Check frequency</label>
            <select
              id="auto_update_schedule"
              disabled={!writable}
              value={schedule.value}
              onChange={(e) =>
                schedule.set(e.currentTarget.value as SettingsResponse['auto_update_schedule'])
              }
            >
              <option value="daily">Daily when idle</option>
              <option value="weekly">Weekly when idle</option>
              <option value="disabled">Off</option>
            </select>
            <span class="help">The first check waits ten minutes after startup.</span>
          </div>
          <SectionActions>
            <TransactButton
              transact={settingsTransact}
              type="submit"
              disabled={!writable || !schedule.dirty}
            >
              Save
            </TransactButton>
            <ActionState state={settingsTransact.state} />
          </SectionActions>
        </form>
      </div>
      <Disclosure
        title="Install a custom image"
        description="Developer installation using an image URL and its SHA-256 digest."
        className="disclosure-offset"
      >
        <div class="section-body">
          <p class="help">
            Images must use the running firmware’s signing key. Switching between development and
            release keys requires a full serial flash. Adding a second signature does not switch
            keys.
          </p>
          <Kv rows={[['Signing key SHA-256', ota?.signing_key_sha256 || 'Unavailable']]} />
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const problem = customImageProblem(url, sha256);
            if (problem) {
              // Nothing leaves the browser on an invalid form.
              customTransact.setState({ text: problem, cls: 'err' });
              return;
            }
            // The URL may carry a signed query; keep it out of UI output.
            beginOtaSession('Installing custom image…', 'custom');
            customTransact.run(() => otaUpdate({ url: url.trim(), sha256: sha256.trim() }), {
              busyText: 'Installing…',
              okText: 'Install started — progress below',
            });
          }}
        >
          <div class="formgrid section-body">
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
          <SectionActions>
            <TransactButton
              transact={customTransact}
              kind="secondary"
              type="submit"
              disabled={!writable}
            >
              Install custom image
            </TransactButton>
            <ActionState state={customTransact.state} />
          </SectionActions>
        </form>
      </Disclosure>
    </Section>
  );
}

function NameCard() {
  const writable = useWritable();
  const transact = useTransact();
  const c = config.value;
  const name = useDeviceField(c?.device_name ?? null);

  return (
    <Section
      gated
      title="Device name"
      lead="Shown in the console header and browser tab so you can tell devices apart."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          transact.run(
            async () => {
              const ack = await setDeviceName({ name: name.value });
              // The snapshot must carry the accepted name, or a remount
              // reverts the form to the old one.
              await loadConfig();
              return ack;
            },
            {
              busyText: 'Saving…',
              okText: 'Saved',
            },
          );
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
              value={name.value}
              onInput={(e) => name.set(e.currentTarget.value)}
            />
            <span class="help">Leave blank to use “Device console”.</span>
          </div>
        </div>
        <SectionActions>
          <TransactButton
            transact={transact}
            type="submit"
            disabled={!writable || !c || !name.dirty}
          >
            Save
          </TransactButton>
          <ActionState state={transact.state} />
        </SectionActions>
      </form>
    </Section>
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
          (secret) => setAdminKey({ admin_key: secret }),
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
    <Section
      gated
      title="Access"
      lead="One admin key protects every change. Reads are open on your network; unlocking lasts 15 minutes."
    >
      <form onSubmit={save}>
        {!staged && (
          <SectionActions>
            <Button disabled={!manageable} onClick={() => setStaged(generateAdminKey())}>
              Replace admin key
            </Button>
            <span class="actionstate">The new key is shown once before it takes effect.</span>
          </SectionActions>
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
              copiedToast="New admin key copied"
            />
            <SectionActions>
              <TransactButton transact={transact} type="submit" disabled={!manageable}>
                Save
              </TransactButton>
              <Button onClick={() => setStaged('')}>Cancel</Button>
              <ActionState state={transact.state} />
            </SectionActions>
          </div>
        )}
      </form>
    </Section>
  );
}

export function ResetCard() {
  const writable = useWritable();
  const restart = useTransact();
  const factory = useTransact();

  // Reset is a handoff, not a reboot wait: the device abandons this network
  // for its setup AP, so the card's last render is the way there.
  const handoff = resetHandoff.value;
  if (handoff) {
    return (
      <Section title="Reset">
        <Notice tone="info">
          <strong class="strong">Factory reset done.</strong> {resetHandoffMessage()} Installed
          firmware stays; every setting was erased.
        </Notice>
        {handoff !== 'unknown' && (
          <Kv
            rows={[
              ['Setup network', handoff.ssid],
              ['Password', handoff.password],
            ]}
          />
        )}
      </Section>
    );
  }

  return (
    <Section
      gated
      title="Maintenance"
      lead="Restart without losing settings, or erase this device for a fresh setup."
    >
      <SettingRow
        title="Restart device"
        description="Audio stops briefly. Your network, profiles, and other settings stay saved."
      >
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
      </SettingRow>
      <SettingRow
        title="Factory reset"
        description="Erase saved settings and return to the setup network. Installed firmware stays."
      >
        <ConfirmButton
          label="Factory reset"
          confirmLabel="Erase everything"
          disabled={!writable}
          message="This erases Wi-Fi credentials, the stream target, audio settings and profiles, transport encryption keys, LED roles, the device name, the update schedule, and the admin key. Installed firmware stays. The device returns to its setup network."
          onConfirm={() =>
            factory.run(
              async () => {
                try {
                  const response = await factoryReset();
                  // The response repeats the setup-network credentials — the
                  // stable ones a pre-flashed unit's label carries.
                  beginResetHandoff(response.setup_network);
                } catch (error) {
                  // A rejection came back over HTTP: inline and retryable.
                  if (error instanceof ApiError) throw error;
                  // A dropped connection is the reset tearing this network
                  // down — the handoff itself, not a failure.
                  beginResetHandoff();
                }
                return undefined;
              },
              { busyText: 'Erasing…', okText: '' },
            )
          }
        />
      </SettingRow>
      <SectionActions compact>
        <ActionState state={restart.state} />
        <ActionState state={factory.state} />
      </SectionActions>
    </Section>
  );
}

function RawStatusCard() {
  return (
    <Section>
      <Disclosure
        title="Raw status"
        description="Inspect the full API response for support or integration debugging."
      >
        <div class="log apidump section-body">{JSON.stringify(status.value, null, 2)}</div>
        <SectionActions compact>
          <span class="actionstate">
            Full JSON at <code>/api/status</code> · Prometheus at <code>/api/metrics</code>
          </span>
        </SectionActions>
      </Disclosure>
    </Section>
  );
}
