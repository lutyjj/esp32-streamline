import { useEffect, useState } from 'preact/hooks';
import { setTarget, setWifi } from '../lib/api';
import { useTransact, useWritable } from '../lib/hooks';
import { config, noBridge, packetsMoving, setupMode, status } from '../state/device';
import { handoffMessage, joinNetwork } from '../state/join';
import { setupKey } from '../state/setupKey';
import { toast } from '../state/toasts';
import { Button } from './Button';
import { Card, CardFooter, CardStack } from './Card';
import { Chip } from './Chip';
import { KeyReveal } from './KeyReveal';
import { ActionState, TransactButton } from './Transact';

export function NetworkTab() {
  const writable = useWritable();
  const s = status.value;
  const setup = setupMode.value;
  const firstSetup = s?.auth_required === false;
  const wifiTransact = useTransact();
  const targetTransact = useTransact();

  const [ssid, setSsid] = useState('');
  const [password, setPassword] = useState('');
  const [editingPassword, setEditingPassword] = useState(false);
  const [targetHost, setTargetHost] = useState('');
  const [targetPort, setTargetPort] = useState('39000');
  const [rememberKey, setRememberKey] = useState(true);

  const c = config.value;
  useEffect(() => {
    if (!c) return;
    setSsid(c.ssid);
    setTargetHost(c.target_host);
    setTargetPort(String(c.target_port));
    setPassword('');
    setEditingPassword(false);
  }, [c]);

  const passwordEditable = firstSetup || editingPassword;

  /**
   * Commissioning is one atomic write (Wi-Fi + the initial target + the admin
   * key): the device leaves for the home network right after, so both cards
   * drive the same first-join handoff. This browser stays behind on the
   * vanishing setup network, so it is a handoff, not a reboot wait.
   */
  async function commission() {
    const host = validTargetHost();
    const data = await joinNetwork({ ssid, password, targetHost: host, targetPort, rememberKey });
    toast(handoffMessage(), 'wait', 0);
    return data;
  }

  function validTargetHost() {
    const host = targetHost.trim();
    if (host.includes(':') || host.includes('/')) {
      throw new Error('target host must not include port, scheme, or path');
    }
    return host;
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
        ? { busyText: 'Saving…', okText: 'Saved — the device is joining your network' }
        : { busyText: 'Saving…', reboots: 'the Wi-Fi settings' },
    );
  }

  function saveTarget() {
    targetTransact.run(
      () =>
        firstSetup
          ? commission()
          : setTarget({ target_host: validTargetHost(), target_port: Number(targetPort) }),
      firstSetup
        ? { busyText: 'Saving…', okText: 'Saved — the device is joining your network' }
        : { busyText: 'Saving…', reboots: 'the stream target' },
    );
  }

  const moving = packetsMoving.value;
  const playing = s?.metrics.playing ?? false;

  return (
    <CardStack>
      <Card
        gated
        title="Wi-Fi"
        lead={
          setup
            ? 'Not configured yet — join the device to your home network.'
            : s
              ? `Connected to ${s.wifi.ssid} · ${s.wifi.rssi} dBm · ${s.wifi.sta_ip}`
              : '—'
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
        <CardFooter>
          <TransactButton transact={wifiTransact} disabled={!writable} onClick={saveWifi}>
            Save &amp; restart
          </TransactButton>
          <ActionState state={wifiTransact.state} />
        </CardFooter>
      </Card>

      <Card
        gated
        title="Stream target"
        lead="Where the audio goes: your bridge or Home Assistant add-on."
      >
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

        {firstSetup && setupKey.value && (
          <div class="keypanel">
            <p>
              <strong class="strong">Your admin key.</strong> It unlocks settings after setup and is
              shown only once — copy it somewhere safe now.
            </p>
            <KeyReveal secret={setupKey.value} remember={rememberKey} onRemember={setRememberKey} />
          </div>
        )}

        <CardFooter>
          <TransactButton transact={targetTransact} disabled={!writable} onClick={saveTarget}>
            Save &amp; restart
          </TransactButton>
          <ActionState state={targetTransact.state} />
          {!setup && !noBridge.value && (
            <Chip tone={moving ? 'good' : playing ? 'warn' : 'neutral'} dot className="healthchip">
              {moving
                ? 'connection healthy'
                : playing
                  ? 'connecting to bridge…'
                  : 'idle — nothing to send'}
            </Chip>
          )}
        </CardFooter>
      </Card>
    </CardStack>
  );
}
