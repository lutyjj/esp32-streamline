import { render } from 'preact';
import { act } from 'preact/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { TransportWizard } from '../src/components/TransportWizard';
import { config, status } from '../src/state/device';
import { setupWizardStep, transport } from '../src/state/transport';
import { deviceConfig, deviceStatus, transportStatus } from './fixtures';

function labels(host: HTMLElement): string[] {
  return [...host.querySelectorAll('button')].map((button) => button.textContent || '');
}

describe('setupWizardStep', () => {
  it('resumes at the step the device key state is in', () => {
    expect(setupWizardStep(transportStatus())).toBe('credential');
    expect(setupWizardStep(transportStatus({ pending_key_id: 'eli1-a' }))).toBe('enroll');
    expect(
      setupWizardStep(transportStatus({ pending_key_id: 'eli1-a', pending_verified: true })),
    ).toBe('activate');
  });
});

describe('TransportWizard', () => {
  beforeEach(() => {
    status.value = deviceStatus({ auth_required: false });
    config.value = deviceConfig({ transport: transportStatus() });
    transport.revealed.value = undefined;
  });

  it('starts a fresh setup with the create action and no way to skip ahead', () => {
    const host = document.createElement('div');
    render(<TransportWizard onClose={() => {}} />, host);

    expect(host.textContent).toContain('Create this device’s bridge credential');
    expect(host.textContent).toContain('Audio keeps playing');
    expect(labels(host)).toContain('Create credential');
    expect(labels(host)).not.toContain('Continue');
  });

  it('offers a replacement only during a real rotation, not for a parked key', () => {
    config.value = deviceConfig({
      transport: transportStatus({
        mode: 'tls-psk',
        active_key_id: 'eli1-0123456789abcdef0123456789abcdef',
      }),
    });
    const host = document.createElement('div');
    render(<TransportWizard onClose={() => {}} />, host);
    expect(labels(host)).toContain('Create replacement credential');

    config.value = deviceConfig({
      transport: transportStatus({
        mode: 'cleartext',
        active_key_id: 'eli1-0123456789abcdef0123456789abcdef',
      }),
    });
    const fresh = document.createElement('div');
    render(<TransportWizard onClose={() => {}} />, fresh);
    expect(labels(fresh)).toContain('Create credential');
    expect(labels(fresh)).not.toContain('Create replacement credential');
  });

  it('shows the one-time credential after staging and advances to enrollment', () => {
    const keyId = 'eli1-0123456789abcdef0123456789abcdef';
    config.value = deviceConfig({ transport: transportStatus() });
    transport.revealed.value = {
      contract_version: 1,
      key_id: keyId,
      psk: '01'.repeat(32),
      recovery: false,
    };
    const host = document.createElement('div');
    render(<TransportWizard onClose={() => {}} />, host);

    expect(host.textContent).toContain(keyId);
    expect(host.textContent).toContain('Copy both values now');
    expect(labels(host)).toContain('Continue');

    const advance = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Continue',
    );
    act(() => advance?.click());

    expect(host.textContent).toContain('Add it to your bridge');
    expect(host.textContent).toContain('http://192.0.2.20:8088/');
    expect(host.textContent).toContain('Encrypt incoming audio');
    expect(labels(host)).toContain('Verify with bridge');
  });

  it('resumes at enrollment with the discard exit when a key is pending', () => {
    config.value = deviceConfig({
      transport: transportStatus({ pending_key_id: 'eli1-0123456789abcdef0123456789abcdef' }),
    });
    const host = document.createElement('div');
    render(<TransportWizard onClose={() => {}} />, host);

    expect(host.textContent).toContain('Add it to your bridge');
    expect(labels(host)).toContain('Verify with bridge');
    expect(labels(host)).toContain('Changed my mind — discard this credential');
  });

  it('resumes at activation once the bridge accepted the credential', () => {
    config.value = deviceConfig({
      transport: transportStatus({
        pending_key_id: 'eli1-0123456789abcdef0123456789abcdef',
        pending_verified: true,
      }),
    });
    const host = document.createElement('div');
    render(<TransportWizard onClose={() => {}} />, host);

    expect(host.textContent).toContain('Turn encryption on');
    expect(host.textContent).toContain('restarts the device');
    expect(labels(host)).toContain('Activate encryption');
  });

  it('always offers a way out without acting', () => {
    let closed = false;
    const host = document.createElement('div');
    render(
      <TransportWizard
        onClose={() => {
          closed = true;
        }}
      />,
      host,
    );

    const leave = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Continue later',
    );
    act(() => leave?.click());

    expect(closed).toBe(true);
  });
});
