import { useEffect, useState } from 'preact/hooks';
import { getSetTargetUrl, getSetWifiUrl, setTarget, setWifi } from '../lib/api';
import { useDeviceField, useTransact, useWritable } from '../lib/hooks';
import { normalizeTargetHost } from '../lib/target';
import { storesWifiPassword, wifiCredentials } from '../lib/wifi';
import {
  bridgeConnection,
  config,
  configResource,
  noBridge,
  onSetupNetwork,
  status,
  unreachable,
} from '../state/device';
import { handoffMessage, joinNetwork } from '../state/join';
import { updateLock } from '../state/ota';
import { setupKey } from '../state/setupKey';
import { toast } from '../state/toasts';
import { BridgeFinder } from './BridgeFinder';
import { Button } from './Button';
import { Chip } from './Chip';
import { Disclosure } from './Disclosure';
import { GuidePrompt } from './GuidePrompt';
import { KeyReveal } from './KeyReveal';
import { OpenNetworkChoice } from './OpenNetworkChoice';
import { ResourceNotice } from './ResourceNotice';
import { Section, SectionActions, SectionStack } from './Section';
import { ActionState, TransactButton } from './Transact';
import { TransportCard } from './TransportCard';

export function NetworkTab({
  onSetupBridge,
  section = 'bridge',
  targetDraftPending = false,
  onTargetDraftPending,
}: {
  onSetupBridge: () => void;
  section?: 'bridge' | 'wifi' | 'security';
  targetDraftPending?: boolean;
  onTargetDraftPending?: (pending: boolean) => void;
}) {
  const writable = useWritable();
  const s = status.value;
  const setup = onSetupNetwork.value;
  const firstSetup = s?.auth_required === false;
  const recovering = s?.mode === 'recovery';
  const wifiTransact = useTransact();
  const targetTransact = useTransact();
  const wifiLock = updateLock(getSetWifiUrl());
  // First setup sends the target with commissioning, a Wi-Fi write.
  const targetLock = updateLock(firstSetup ? getSetWifiUrl() : getSetTargetUrl());

  const c = config.value;
  const { value: ssid, set: setSsid } = useDeviceField(c?.ssid ?? null);
  const [password, setPassword] = useState('');
  const [editingPassword, setEditingPassword] = useState(false);
  const openField = useDeviceField(c ? String(c.open_network) : null);
  const open = openField.value === 'true';
  const { value: targetHost, set: setTargetHost } = useDeviceField(c?.target_host ?? null);
  const { value: targetPort, set: setTargetPort } = useDeviceField(
    c ? String(c.target_port) : null,
  );
  const [rememberKey, setRememberKey] = useState(true);
  const [keySaved, setKeySaved] = useState(false);

  const storedPassword = storesWifiPassword(c);
  const passwordEditable = !open && (!storedPassword || editingPassword);

  function credentials() {
    return wifiCredentials(open, passwordEditable ? password : '', storedPassword);
  }

  /**
   * A Wi-Fi save on the setup network sends the device away from this browser,
   * so it is a handoff, not a reboot wait. Commissioning is one atomic write
   * (Wi-Fi, the initial target, the admin key), so both cards drive it; a
   * recovery change keeps the stored target and key.
   */
  async function handOff() {
    await joinNetwork({
      ssid,
      credentials: credentials(),
      target: firstSetup ? { host: normalizeTargetHost(targetHost), port: targetPort } : undefined,
      rememberKey,
    });
    toast(handoffMessage(), 'wait', 0);
    return undefined;
  }
  const handOffOpts = {
    busyText: 'Saving…',
    okText: 'Follow the network handoff instructions above.',
  };

  /** Steady state: Wi-Fi and the stream target are separate writes, so a bad
   * target host cannot fail a Wi-Fi save and vice versa. */
  function saveWifi() {
    wifiTransact.run(
      () => (setup ? handOff() : setWifi({ ssid: ssid.trim(), ...credentials() })),
      setup ? handOffOpts : { busyText: 'Saving…', reboots: 'the Wi-Fi settings' },
    );
  }

  function saveTarget() {
    targetTransact.run(
      () =>
        firstSetup
          ? handOff()
          : setTarget({
              target_host: normalizeTargetHost(targetHost),
              target_port: Number(targetPort),
            }),
      firstSetup ? handOffOpts : { busyText: 'Saving…', reboots: 'the stream target' },
    );
  }

  const moving = bridgeConnection.value === 'sending';
  const connecting = bridgeConnection.value === 'connecting';
  const targetDirty = Boolean(
    c &&
      (targetHost.trim() !== c.target_host ||
        (targetPort !== '' && Number(targetPort) !== c.target_port)),
  );

  useEffect(() => {
    onTargetDraftPending?.(targetDirty || targetTransact.busy);
  }, [targetDirty, targetTransact.busy, onTargetDraftPending]);

  const wifiPanel = (
    <>
      <Section
        gated
        title="Wi-Fi"
        lead={
          unreachable.value
            ? 'Device unavailable. Connection details are last known; check your network.'
            : recovering
              ? 'Not connected. Change the details below if the network’s name or password changed.'
              : setup
                ? 'Not configured yet — join the device to your home network.'
                : s?.wifi.status === 'connected'
                  ? `Connected to ${s.wifi.ssid} · ${s.wifi.rssi_dbm} dBm · ${s.wifi.sta_ip}`
                  : s
                    ? 'Wi-Fi disconnected. Check your router or update the network below.'
                    : 'Checking Wi-Fi…'
        }
      >
        {recovering && s.diagnostics.last_fallback && (
          <Disclosure title="Startup report">
            <p class="lead">{s.diagnostics.last_fallback}</p>
          </Disclosure>
        )}
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
                autocomplete={storedPassword ? 'off' : 'new-password'}
                placeholder={
                  open
                    ? 'none'
                    : !storedPassword
                      ? 'network password'
                      : passwordEditable
                        ? 'new password'
                        : 'unchanged'
                }
                disabled={!writable || !passwordEditable}
                value={passwordEditable ? password : ''}
                onInput={(e) => setPassword(e.currentTarget.value)}
              />
              {storedPassword && !open && (
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
            {!open && (
              <span class="help">
                {storedPassword
                  ? 'The saved password stays unless you change it here.'
                  : 'The password of the Wi-Fi network the device should join.'}
              </span>
            )}
            <OpenNetworkChoice
              checked={open}
              disabled={!writable}
              onChange={(checked) => openField.set(String(checked))}
            />
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
            disabled={!writable || !c || (firstSetup && !keySaved) || wifiLock !== null}
            onClick={saveWifi}
          >
            Save &amp; restart
          </TransactButton>
          <ActionState state={wifiTransact.state} />
          {wifiLock && <span class="help">{wifiLock}</span>}
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

      {!setup && (
        <BridgeFinder
          host={targetHost}
          port={targetPort}
          disabled={!writable}
          onUse={(bridge) => {
            setTargetHost(bridge.host);
            setTargetPort(String(bridge.port));
          }}
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
          disabled={!writable || !c || (firstSetup && !keySaved) || targetLock !== null}
          onClick={saveTarget}
        >
          Save &amp; restart
        </TransactButton>
        <ActionState state={targetTransact.state} />
        {targetLock && <span class="help">{targetLock}</span>}
        {!setup && !noBridge.value && (
          <Chip tone={moving ? 'good' : connecting ? 'warn' : 'neutral'} dot className="healthchip">
            {bridgeConnection.value === 'unavailable'
              ? 'connection unavailable'
              : moving
                ? 'sending audio'
                : connecting
                  ? 'connecting to bridge…'
                  : s?.stream.enabled
                    ? 'input is quiet'
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
        <TransportCard targetDirty={targetDirty || targetDraftPending} />
      )}
    </>
  );
}
