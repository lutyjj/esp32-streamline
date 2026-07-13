import { render } from 'preact';
import { act } from 'preact/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { BridgeApp, SourceCard } from '../src/bridge/BridgeApp';
import { bridge } from '../src/bridge/state';
import type { SourceSnapshot } from '../src/generated/bridge';

function source(rms: number): SourceSnapshot {
  return {
    packets: 1,
    lost: 0,
    concealed: 0,
    late: 0,
    reordered: 0,
    duplicate: 0,
    underruns: 0,
    buffered_packets: 0,
    playout_buffer_packets: 1,
    max_outage_silence_packets: 1,
    bytes: 1024,
    frames: 256,
    played_frames: 0,
    rate: 48000,
    packet_frames: 256,
    playout_seq: 1,
    last_seq: 1,
    highest_seq: 1,
    last_packet_at: 1,
    last_playout_at: null,
    buffer_ready_at: null,
    started_at: 1,
    tcp_connections: 1,
    tcp_disconnects: 0,
    tcp_errors: 0,
    uptime_seconds: 1,
    clients: 0,
    client_buffer_chunks: 4,
    client_queue_drops: 0,
    slow_clients: 0,
    client_streams: [],
    levels: { peak_left: rms, peak_right: rms, rms_left: rms, rms_right: rms },
    lifecycle: {
      state: 'connected',
      dynamic: true,
      http_clients: 0,
      recording_sessions: 0,
      idle_seconds: 0,
      eviction_idle_seconds: 300,
      peer_ip: '192.0.2.10',
      transport: 'cleartext',
    },
  };
}

describe('bridge source view', () => {
  it('updates a keyed meter without replacing its card DOM node', () => {
    const host = document.createElement('div');
    render(<SourceCard ip="192.0.2.10" source={source(100)} />, host);
    const card = host.querySelector('.source-card');

    render(<SourceCard ip="192.0.2.10" source={source(10000)} />, host);

    expect(host.querySelector('.source-card')).toBe(card);
    expect(host.textContent).toContain('-10.3 / -10.3 dBFS');
  });

  it('renders the lifecycle state as a toned status chip', () => {
    const host = document.createElement('div');
    render(<SourceCard ip="192.0.2.10" source={source(100)} />, host);
    const chip = host.querySelector('.source-head .chip');
    expect(chip?.className).toContain('good');
    expect(chip?.textContent).toBe('connected');
    expect(chip?.querySelector('.statusdot.good')).not.toBeNull();
  });
});

describe('bridge lock flow', () => {
  beforeEach(() => {
    sessionStorage.clear();
    bridge.status.value = {
      bridge_version: 'test',
      sources: {},
      transport: {
        contract_version: 1,
        cleartext_enabled: true,
        tls_enabled: true,
        cleartext_port: 39000,
        tls_port: 39001,
        key_ids: [],
        auth_successes: 0,
        auth_failures: 0,
      },
    };
    bridge.recordings.value = undefined;
    bridge.error.value = '';
  });

  it('reveals the unlock panel from the masthead lock chip while locked', () => {
    bridge.recordingState.value = 'locked';
    const host = document.createElement('div');
    render(<BridgeApp />, host);

    const chip = host.querySelector<HTMLButtonElement>('button.lockchip');
    expect(chip?.textContent).toContain('Locked');
    expect(host.querySelector('.unlockpanel')).toBeNull();

    act(() => chip?.click());
    expect(host.querySelector('.unlockpanel input')).not.toBeNull();
  });

  it('locks straight from the masthead chip when unlocked', () => {
    bridge.recordingState.value = 'unlocked';
    const host = document.createElement('div');
    render(<BridgeApp />, host);

    expect(host.querySelector('button.lockchip')?.textContent).toContain('Unlocked');

    act(() => host.querySelector<HTMLButtonElement>('button.lockchip')?.click());
    expect(bridge.recordingState.value).toBe('locked');
    expect(host.querySelector('button.lockchip')?.textContent).toContain('Locked');
  });
});
