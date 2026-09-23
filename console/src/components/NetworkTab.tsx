import { useState } from 'preact/hooks';
import { setTarget, setWifi } from '../lib/api';
import { useDeviceField, useTransact, useWritable } from '../lib/hooks';
import { normalizeTargetHost } from '../lib/target';
import {
  bridgeConnection,
  config,
  configResource,
  noBridge,
  setupMode,
  status,
  unreachable,
} from '../state/device';
import { handoffMessage, joinNetwork } from '../state/join';
import { setupKey } from '../state/setupKey';
import { toast } from '../state/toasts';
import { Button } from './Button';
import { Chip } from './Chip';
import { GuidePrompt } from './GuidePrompt';
import { KeyReveal } from './KeyReveal';
import { ResourceNotice } from './ResourceNotice';
import { Section, SectionActions, SectionStack } from './Section';
import { ActionState, TransactButton } from './Transact';
import { TransportCard } from './TransportCard';

export function NetworkTab({
  onSetupBridge,
  section = 'bridge',
}: {
  onSetupBridge: () => void;
  section?: 'bridge' | 'wifi' | 'security';
}) {
  const writable = useWritable();
  const s = status.value;
  const setup = setupMode.value;
  const firstSetup = s?.auth_required === false;
  const wifiTransact = useTransact();
  const targetTransact = useTransact();

  const c = config.value;
  const { value: ssid, set: setSsid } = useDeviceField(c?.ssid ?? null);
  const [password, setPassword] = useState('');
  const [editingPassword, setEditingPassword] = useState(false);
  const { value: targetHost, set: setTargetHost } = useDeviceField(c?.target_host ?? null);
  const { value: targetPort, set: setTargetPort } = useDeviceField(
    c ? String(c.target_port) : null,
  );
  const [rememberKey, setRememberKey] = useState(true);
  const [keySaved, setKeySaved] = useState(false);

  const passwordEditable = firstSetup || editingPassword;

  /**
   * Commissioning is one atomic write (Wi-Fi + the initial target + the admin
   * key): the device leaves for the home network right after, so both cards
   * drive the same first-join handoff. This browser stays behind on the
   * vanishing setup network, so it is a handoff, not a reboot wait.
   */
  async function commission() {
    const host = normalizeTargetHost(targetHost);
    const data = await joinNetwork({ ssid, password, targetHost: host, targetPort, rememberKey });
    toast(handoffMessage(), 'wait', 0);
    return data;
  }

  /** Steady state: Wi-Fi and the stream target are separate writes, so a bad
   * target host cannot fail a Wi-Fi save and vice versa. */
  function saveWifi() {
    wifiTransact.run(
      () =>
        firstSetup
          ? commission()
          : setWifi({ ssid: ssid.trim(), password: passwordEditable ? password : '' }),
      firstSetup
        ? { busyText: 'Saving…', okText: 'Follow the network handoff instructions above.' }
        : { busyText: 'Saving…', reboots: 'the Wi-Fi settings' },
    );
  }

  function saveTarget() {
    targetTransact.run(
      () =>
        firstSetup
          ? commission()
          : setTarget({
              target_host: normalizeTargetHost(targetHost),
              target_port: Number(targetPort),
            }),
      firstSetup
        ? { busyText: 'Saving…', okText: 'Follow the network handoff instructions above.' }
        : { busyText: 'Saving…', reboots: 'the stream target' },
    );
  }

  const moving = bridgeConnection.value === 'sending';
  const connecting = bridgeConnection.value === 'connecting';
  const targetDirty = Boolean(
    c &&
      (targetHost.trim() !== c.target_host ||
        (targetPort !== '' && Number(targetPort) !== c.target_port)),
  );

  const wifiPanel = (
    <>
      <Section
        gated
        title="Wi-Fi"
        lead={
          unreachable.value
            ? 'Device unavailable. Connection details are last known; check your network.'
            : setup
              ? 'Not configured yet — join the device to your home network.'
              : s?.wifi.status === 'connected'
                ? `Connected to ${s.wifi.ssid} · ${s.wifi.rssi_dbm} dBm · ${s.wifi.sta_ip}`
                : s
                  ? 'Wi-Fi disconnected. Check your router or update the network below.'
                  : 'Checking Wi-Fi…'
        }
      >
        <div class="formgrid">
          <div class="field">
            <label for="ssid">Network name</label>
            <input
              id="ssid"
              type="text"
              autocomplete="off"
              disabled={!writable}
              value={ssid}
              onInput={(e) => setSsid(e.currentTarget.value)}
            />
          </div>
          <div class="field">
            <label for="password">Password</label>
            <div class="inputrow">
              <input
                id="password"
                type="password"
                autocomplete={firstSetup ? 'new-password' : 'off'}
                placeholder={
                  firstSetup ? 'network password' : passwordEditable ? 'new password' : 'unchanged'
                }
                disabled={!writable || !passwordEditable}
                value={password}
                onInput={(e) => setPassword(e.currentTarget.value)}
              />
              {!firstSetup && (
                <Button
                  disabled={!writable}
                  onClick={() => {
                    setEditingPassword(!editingPassword);
                    if (editingPassword) setPassword('');
                  }}
                >
                  {editingPassword ? 'Keep current' : 'Change'}
                </Button>
              )}
            </div>
            <span class="help">
              {firstSetup
                ? 'The password of the Wi-Fi network the device should join.'
                : 'The saved password stays unless you change it here.'}
            </span>
          </div>
        </div>
        {firstSetup && setupKey.value && (
          <div class="keypanel">
            <p>
              Save this admin key before joining. You need it at the device’s new address; browser
              storage does not transfer between addresses.
            </p>
            <KeyReveal secret={setupKey.value} remember={rememberKey} onRemember={setRememberKey} />
            <label>
              <input
                type="checkbox"
                checked={keySaved}
                onChange={(event) => setKeySaved(event.currentTarget.checked)}
              />{' '}
              I saved my admin key outside this page
            </label>
          </div>
        )}
        <SectionActions>
          <TransactButton
            transact={wifiTransact}
            disabled={!writable || !c || (firstSetup && !keySaved)}
            onClick={saveWifi}
          >
            Save &amp; restart
          </TransactButton>
          <ActionState state={wifiTransact.state} />
        </SectionActions>
      </Section>
      {!setup && (
        <Section
          title="Setup network"
          lead="If the device ever loses this Wi-Fi it broadcasts its own protected network."
        >
          <p class="lead">
            Its password never changes: it is on a pre-flashed device’s label and in the flasher’s
            log. Without it, hold the board’s first key while powering on to open the network for
            one boot.
          </p>
        </Section>
      )}
    </>
  );
  const bridgePanel = (
    <Section
      gated
      title="Stream target"
      lead="Where the audio goes: your bridge or Home Assistant add-on."
    >
      {!setup && (
        <GuidePrompt
          text={
            noBridge.value
              ? 'Not sure what to enter? The guide picks it up from here.'
              : 'Prefer step by step? Reconnect with the guide.'
          }
          action={noBridge.value ? 'Set up bridge' : 'Guide me'}
          primary={noBridge.value}
          disabled={!writable}
          onAction={onSetupBridge}
        />
      )}

      <div class="formgrid">
        <div class="field">
          <label for="target_host">Host or IP</label>
          <input
            id="target_host"
            type="text"
            autocomplete="off"
            disabled={!writable}
            value={targetHost}
            onInput={(e) => setTargetHost(e.currentTarget.value)}
          />
        </div>
        <div class="field">
          <label for="target_port">Port</label>
          <input
            id="target_port"
            type="number"
            min="1"
            max="65535"
            disabled={!writable}
            value={targetPort}
            onInput={(e) => setTargetPort(e.currentTarget.value)}
          />
        </div>
      </div>

      <SectionActions>
        <TransactButton
          transact={targetTransact}
          disabled={!writable || !c || (firstSetup && !keySaved)}
          onClick={saveTarget}
        >
          Save &amp; restart
        </TransactButton>
        <ActionState state={targetTransact.state} />
        {!setup && !noBridge.value && (
          <Chip tone={moving ? 'good' : connecting ? 'warn' : 'neutral'} dot className="healthchip">
            {bridgeConnection.value === 'unavailable'
              ? 'connection unavailable'
              : moving
                ? 'sending audio'
                : connecting
                  ? 'connecting to bridge…'
                  : s?.stream.enabled
                    ? 'idle — nothing to send'
                    : 'streaming paused'}
          </Chip>
        )}
      </SectionActions>
    </Section>
  );
  return (
    <>
      <ResourceNotice of={configResource} />
      {firstSetup ? (
        <SectionStack>
          {wifiPanel}
          {bridgePanel}
        </SectionStack>
      ) : section === 'wifi' ? (
        wifiPanel
      ) : section === 'bridge' ? (
        bridgePanel
      ) : noBridge.value ? (
        <p>Set an audio destination before setting up encryption.</p>
      ) : (
        <TransportCard targetDirty={targetDirty} />
      )}
    </>
  );
}
