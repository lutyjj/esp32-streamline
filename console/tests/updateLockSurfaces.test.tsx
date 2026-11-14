import { type ComponentChildren, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AudioTab } from '../src/components/AudioTab';
import { BridgeWizard } from '../src/components/BridgeWizard';
import { NetworkTab } from '../src/components/NetworkTab';
import { TransportCard } from '../src/components/TransportCard';
import { TransportWizard } from '../src/components/TransportWizard';
import { forgetAdminKey, unlockSettings } from '../src/lib/adminKey';
import { deviceConfig, deviceContract, deviceStatus, transportStatus } from '../src/mocks/fixtures';
import { config, contract, status } from '../src/state/device';
import { UPDATE_BUSY_REASON } from '../src/state/ota';

const KEY_ID = 'eli1-0123456789abcdef0123456789abcdef';
let host: HTMLElement;

function button(label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find((b) => b.textContent === label);
}

function click(label: string): void {
  act(() => button(label)?.click());
}

function updating(busy: boolean): void {
  act(() => {
    status.value = deviceStatus({ ota: { busy, phase: busy ? 'checking' : 'idle' } });
  });
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
});
