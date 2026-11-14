import { type ComponentChildren, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AudioProfiles } from '../src/components/AudioProfiles';
import { AudioTab } from '../src/components/AudioTab';
import { BridgeWizard } from '../src/components/BridgeWizard';
import { NetworkTab } from '../src/components/NetworkTab';
import { OnboardingOverlay } from '../src/components/OnboardingOverlay';
import { TransportCard } from '../src/components/TransportCard';
import { TransportWizard } from '../src/components/TransportWizard';
import { forgetAdminKey, unlockSettings } from '../src/lib/adminKey';
import { deviceConfig, deviceContract, deviceStatus, transportStatus } from '../src/mocks/fixtures';
import { audioProfiles, config, contract, status } from '../src/state/device';
import { UPDATE_BUSY_REASON } from '../src/state/ota';
import { transport } from '../src/state/transport';

const KEY_ID = 'eli1-0123456789abcdef0123456789abcdef';
let host: HTMLElement;

function button(label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find((b) => b.textContent === label);
}

function click(label: string): void {
  act(() => button(label)?.click());
}

function updating(busy: boolean, mode: 'setup' | 'provisioned' = 'provisioned'): void {
  act(() => {
    status.value = deviceStatus({
      mode,
      auth_required: mode === 'provisioned',
      ota: { busy, phase: busy ? 'checking' : 'idle' },
    });
  });
}

function type(selector: string, value: string): void {
  const field = host.querySelector<HTMLInputElement>(selector);
  if (!field) throw new Error(`${selector} missing`);
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Render `view` during an update, then once it ends, and return `label`'s disabled states. */
function lockedThenFree(
  view: ComponentChildren,
  label: string,
  open: string[] = [],
  prepare: () => void = () => {},
): boolean[] {
  act(() => render(null, host));
  updating(true);
  act(() => render(view, host));
  for (const step of open) click(step);
  act(prepare);
  const during = button(label)?.disabled;
  expect(host.textContent, label).toContain(UPDATE_BUSY_REASON);
  updating(false);
  expect(host.textContent, label).not.toContain(UPDATE_BUSY_REASON);
  return [Boolean(during), Boolean(button(label)?.disabled)];
}

beforeEach(() => {
  host = document.createElement('div');
  contract.value = deviceContract();
  config.value = deviceConfig();
  unlockSettings('a'.repeat(48), false);
});

afterEach(() => {
  render(null, host);
  contract.value = null;
  status.value = null;
  config.value = null;
  audioProfiles.value = null;
  transport.revealed.value = undefined;
  forgetAdminKey();
});

describe('actions that restart the device during an update', () => {
  it('waits to save Wi-Fi and the stream target', () => {
    expect(
      lockedThenFree(<NetworkTab section="wifi" onSetupBridge={() => {}} />, 'Save & restart'),
    ).toEqual([true, false]);
    expect(
      lockedThenFree(<NetworkTab section="bridge" onSetupBridge={() => {}} />, 'Save & restart'),
    ).toEqual([true, false]);
  });

  it('waits to save input levels or apply a profile', () => {
    expect(
      lockedThenFree(<AudioTab onCalibrate={() => {}} onSetupBridge={() => {}} />, 'Save', [], () =>
        type('#input_gain', '5'),
      ),
    ).toEqual([true, false]);
    audioProfiles.value = {
      board_id: deviceStatus().capabilities.board_id,
      schema_version: 1,
      profiles: [
        {
          id: 'vinyl',
          name: 'Vinyl',
          audio: { input_line: 2, input_gain: 0, adc_attenuation_db: 9 },
        },
      ],
      active_profile_id: null,
    };
    expect(lockedThenFree(<AudioProfiles />, 'Apply profile')).toEqual([true, false]);
  });

  it('waits to commission the device from first-run setup', () => {
    const join = 'I saved my key, join network';
    act(() => render(null, host));
    updating(true, 'setup');
    act(() => render(<OnboardingOverlay onClose={() => {}} />, host));
    act(() => {
      type('#ob_ssid', 'Home');
      type('#ob_password', 'correct horse');
    });
    click('Continue');
    expect(button(join)?.disabled).toBe(true);
    expect(host.textContent).toContain(UPDATE_BUSY_REASON);
    updating(false, 'setup');
    expect(button(join)?.disabled).toBe(false);
  });

  it('waits to calibrate input levels', () => {
    expect(
      lockedThenFree(
        <AudioTab onCalibrate={() => {}} onSetupBridge={() => {}} />,
        'Calibrate input',
      ),
    ).toEqual([true, false]);
  });

  it('waits to save the bridge guide target', () => {
    config.value = deviceConfig({ target_host: '' });
    const typeHost = () => {
      const field = host.querySelector<HTMLInputElement>('#wiz_host');
      if (!field) throw new Error('host field missing');
      field.value = '192.0.2.21';
      field.dispatchEvent(new Event('input', { bubbles: true }));
    };
    expect(
      lockedThenFree(<BridgeWizard onClose={() => {}} />, 'Save & connect', ['Continue'], typeHost),
    ).toEqual([true, false]);
  });

  it('waits to activate encryption', () => {
    config.value = deviceConfig({
      transport: transportStatus({ pending_key_id: KEY_ID, pending_verified: true }),
    });
    expect(lockedThenFree(<TransportWizard onClose={() => {}} />, 'Activate encryption')).toEqual([
      true,
      false,
    ]);
  });

  it('waits to change the active credential or leave encryption', () => {
    config.value = deviceConfig({
      transport: transportStatus({
        mode: 'tls-psk',
        active_key_id: KEY_ID,
        rollback_key_id: `${KEY_ID.slice(0, -1)}0`,
      }),
    });
    const card = <TransportCard />;
    expect(lockedThenFree(card, 'Use previous credential', ['Disable encryption'])).toEqual([
      true,
      false,
    ]);
    expect(lockedThenFree(card, 'Disable encryption & restart', ['Disable encryption'])).toEqual([
      true,
      false,
    ]);
  });

  it('waits to restart into cleartext after a credential recovery', () => {
    config.value = deviceConfig({
      transport: transportStatus({ pending_key_id: KEY_ID }),
    });
    transport.revealed.value = {
      contract_version: 1,
      key_id: KEY_ID,
      psk: '01'.repeat(32),
      recovery: true,
    };
    const summary = () =>
      [...host.querySelectorAll<HTMLButtonElement>('.disclosure-summary')]
        .find((b) => b.textContent === 'Recovery')
        ?.click();
    expect(lockedThenFree(<TransportCard />, 'Restart into cleartext', [], summary)).toEqual([
      true,
      false,
    ]);
  });
});
