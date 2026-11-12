import { render } from 'preact';
import { act } from 'preact/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { MusicAssistant } from '../src/bridge/MusicAssistant';
import { sendspinSourceView } from '../src/bridge/sendspin';
import { bridge } from '../src/bridge/state';
import type { BridgeStatus, SendspinSourceSnapshot } from '../src/generated/bridge';

function published(overrides: Partial<SendspinSourceSnapshot> = {}): SendspinSourceSnapshot {
  return {
    source: '192.0.2.10',
    client_id: 'client-a',
    name: 'StreamLine 192.0.2.10',
    connection: 'connected',
    paired: true,
    input_enabled: true,
    streaming: false,
    signal: 'absent',
    ...overrides,
  };
}

function status(sendspin: BridgeStatus['sendspin']): BridgeStatus {
  return {
    bridge_version: 'test',
    api_token_configured: true,
    sources: {},
    transport: {
      contract_version: 1,
      mode: 'cleartext',
      configurable: true,
      port: 39000,
      key_ids: [],
      auth_successes: 0,
      auth_failures: 0,
    },
    sendspin,
  };
}

describe('Music Assistant source state', () => {
  it('leads with the step that unblocks the source', () => {
    const cases: Array<[Partial<SendspinSourceSnapshot>, string, boolean]> = [
      [{ connection: 'connecting', paired: false, input_enabled: false }, 'Connecting', false],
      [{ paired: false, input_enabled: false }, 'Needs pairing', true],
      [{ input_enabled: false }, 'Input off', false],
      [{ streaming: true, signal: 'present' }, 'Playing', false],
      [{}, 'Ready', false],
    ];
    for (const [overrides, label, needsPairing] of cases) {
      const view = sendspinSourceView(published(overrides));
      expect([view.label, view.needsPairing]).toEqual([label, needsPairing]);
    }
  });

  it('names the source and Music Assistant step a pairing needs', () => {
    expect(sendspinSourceView(published({ paired: false })).detail).toContain(
      '“StreamLine 192.0.2.10” in Music Assistant',
    );
  });
});

describe('Music Assistant settings', () => {
  beforeEach(() => {
    bridge.access.value = 'unlocked';
    bridge.pairingToken.value = null;
  });

  it('names the setting that turns publishing on', () => {
    const host = document.createElement('div');
    bridge.status.value = status({ enabled: false, server_url: '', sources: [] });

    render(<MusicAssistant />, host);

    expect(host.textContent).toContain('sendspin_server_url');
  });

  it('offers pairing only while unlocked', () => {
    const host = document.createElement('div');
    bridge.status.value = status({
      enabled: true,
      server_url: 'ws://192.0.2.30:8927/sendspin',
      sources: [published({ paired: false, input_enabled: false })],
    });

    render(<MusicAssistant />, host);
    expect(host.querySelector('button')?.textContent).toBe('Create pairing token');

    act(() => {
      bridge.access.value = 'locked';
    });
    expect(host.querySelector('button')).toBeNull();
    expect(host.textContent).toContain('Unlock to pair a source.');
  });

  it('shows the one-time token for the named source until dismissed', () => {
    const host = document.createElement('div');
    bridge.status.value = status({
      enabled: true,
      server_url: 'ws://192.0.2.30:8927/sendspin',
      sources: [published({ paired: false, input_enabled: false })],
    });
    bridge.pairingToken.value = { source: '192.0.2.10', client_id: 'client-a', token: 'SP:0TOKEN' };

    render(<MusicAssistant />, host);
    expect(host.querySelector('.keyblock')?.textContent).toBe('SP:0TOKEN');
    expect(host.textContent).toContain('“StreamLine 192.0.2.10” in Music Assistant');

    const done = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('Done'),
    );
    act(() => done?.click());
    expect(host.querySelector('.keyblock')).toBeNull();
  });
});
