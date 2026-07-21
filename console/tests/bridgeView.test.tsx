import { render } from 'preact';
import { act } from 'preact/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { BridgeApp, SourceCard } from '../src/bridge/BridgeApp';
import { bridge } from '../src/bridge/state';
import type { RecordingSnapshot, SourceSnapshot } from '../src/generated/bridge';

function source(rms: number): SourceSnapshot {
  return {
    packets: 1,
    lost: 0,
    concealed: 0,
    late: 0,
    reordered: 0,
    duplicate: 0,
    underruns: 0,
    overflows: 0,
    buffered_packets: 0,
    playout_buffer_packets: 1,
    max_buffered_packets: 48,
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
      admission: 'open',
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
      api_token_configured: true,
      sources: {},
      transport: {
        contract_version: 1,
        mode: 'tls-psk',
        configurable: true,
        port: 39000,
        key_ids: [],
        auth_successes: 0,
        auth_failures: 0,
      },
    };
    bridge.recordings.value = undefined;
    bridge.error.value = '';
  });

  it('reveals the unlock panel from the masthead lock chip while locked', () => {
    bridge.access.value = 'locked';
    const host = document.createElement('div');
    render(<BridgeApp />, host);

    const chip = host.querySelector<HTMLButtonElement>('button.lockchip');
    expect(chip?.textContent).toContain('Locked');
    expect(host.querySelector('.unlockpanel')).toBeNull();

    act(() => chip?.click());
    expect(host.querySelector('.unlockpanel input')).not.toBeNull();
  });

  it('locks straight from the masthead chip when unlocked', () => {
    bridge.access.value = 'unlocked';
    const host = document.createElement('div');
    render(<BridgeApp />, host);

    expect(host.querySelector('button.lockchip')?.textContent).toContain('Unlocked');

    act(() => host.querySelector<HTMLButtonElement>('button.lockchip')?.click());
    expect(bridge.access.value).toBe('locked');
    expect(host.querySelector('button.lockchip')?.textContent).toContain('Locked');
  });

  it('names the missing token instead of offering an unlock', () => {
    bridge.access.value = 'no-token';
    const host = document.createElement('div');
    render(<BridgeApp />, host);

    const chip = host.querySelector<HTMLButtonElement>('button.lockchip');
    expect(chip?.textContent).toContain('No API token');
    act(() => chip?.click());
    expect(host.querySelector('.unlockpanel')).toBeNull();
    expect(host.textContent).toContain('Set api_token');
  });

  it('renders transport credentials with the shared labeled field structure', () => {
    bridge.access.value = 'unlocked';
    const host = document.createElement('div');
    render(<BridgeApp />, host);

    const credential = host.querySelector<HTMLInputElement>('#transport-key-id');
    const psk = host.querySelector<HTMLInputElement>('#transport-psk');
    expect(credential?.getAttribute('type')).toBe('text');
    expect(credential?.classList.contains('credential-input')).toBe(true);
    expect(psk?.classList.contains('credential-input')).toBe(true);
    expect(host.querySelector('label[for="transport-key-id"]')?.textContent).toBe('Credential ID');
  });

  it('gates the encryption switch behind the one console lock', () => {
    bridge.access.value = 'locked';
    const host = document.createElement('div');
    render(<BridgeApp />, host);

    const toggle = host.querySelector<HTMLInputElement>('.transport-mode input[role="switch"]');
    expect(toggle?.checked).toBe(true);
    expect(toggle?.disabled).toBe(true);
    expect(host.querySelector('#transport-key-id')).toBeNull();

    bridge.access.value = 'unlocked';
    render(<BridgeApp />, host);
    const unlocked = host.querySelector<HTMLInputElement>('.transport-mode input[role="switch"]');
    expect(unlocked?.disabled).toBe(false);
  });
});

describe('recording states drive their own affordances', () => {
  function snapshot(overrides: Partial<RecordingSnapshot>): RecordingSnapshot {
    return {
      audio_started_at: null,
      bytes: 1024,
      created_at: '2026-07-17T10:00:00Z',
      duplicate_packets: 0,
      duration_seconds: 10,
      error: null,
      file_name: 'take.wav',
      finished_at: null,
      frames: 100,
      gap_packets: 0,
      id: 'rec-1',
      source: '192.0.2.10',
      state: 'complete',
      title: 'Take',
      ...overrides,
    };
  }

  function mountWith(items: RecordingSnapshot[]): HTMLElement {
    bridge.access.value = 'unlocked';
    bridge.capabilities.value = {
      enabled: true,
      format: {
        bytes_per_second: 176400,
        bits_per_sample: 16,
        channels: 2,
        codec: 'pcm_s16le',
        container: 'wav',
        sample_rate: 44100,
      },
      limits: {
        max_duration_seconds: 5400,
        max_gap_seconds: 300,
        max_title_chars: 48,
        min_free_bytes: 1,
        queue_chunks: 64,
      },
    };
    const active = items.filter((i) =>
      ['waiting-for-audio', 'recording', 'finalizing'].includes(i.state),
    );
    bridge.recordings.value = {
      active,
      saved: items.filter((i) => !active.includes(i)),
      storage: { free_bytes: 5_000_000_000 },
    };
    const host = document.createElement('div');
    render(<BridgeApp />, host);
    return host;
  }

  function cardButtons(host: HTMLElement, id: string): string[] {
    const card = [...host.querySelectorAll('article.recording')].find((el) =>
      el.textContent?.includes(id),
    );
    return [...(card?.querySelectorAll('button') ?? [])].map((b) => b.textContent || '');
  }

  it('offers stop only while audio can still arrive, download only with a file', () => {
    const host = mountWith([
      snapshot({ id: 'r-wait', title: 'wait', state: 'waiting-for-audio', file_name: null }),
      snapshot({ id: 'r-rec', title: 'rec', state: 'recording', file_name: null }),
      snapshot({ id: 'r-fin', title: 'fin', state: 'finalizing', file_name: null }),
      snapshot({ id: 'r-done', title: 'done', state: 'complete' }),
      snapshot({ id: 'r-int', title: 'int', state: 'interrupted' }),
      snapshot({ id: 'r-empty', title: 'nofile', state: 'empty', file_name: null }),
    ]);

    expect(cardButtons(host, 'wait')).toEqual(['Stop and save']);
    expect(cardButtons(host, 'rec')).toEqual(['Stop and save']);
    // Finalizing can no longer be stopped and has no file yet.
    expect(cardButtons(host, 'fin')).toEqual([]);
    expect(cardButtons(host, 'done')).toEqual(['Download WAV', 'Delete']);
    expect(cardButtons(host, 'int')).toEqual(['Download WAV', 'Delete']);
    // No file: nothing to download, but the entry can be cleaned up.
    expect(cardButtons(host, 'nofile')).toEqual(['Delete']);
  });

  it('surfaces the error and integrity counters the contract reports', () => {
    const host = mountWith([
      snapshot({
        id: 'r-err',
        title: 'hurt',
        state: 'interrupted',
        error: 'bridge restarted mid-write',
        gap_packets: 3,
        duplicate_packets: 2,
      }),
    ]);
    const card = [...host.querySelectorAll('article.recording')].find((el) =>
      el.textContent?.includes('hurt'),
    );
    expect(card?.textContent).toContain('bridge restarted mid-write');
    expect(card?.textContent).toContain('3 silent gaps');
    expect(card?.textContent).toContain('2 duplicate packets');
  });

  it('sizes the estimate and limits from the capability contract', () => {
    const host = mountWith([]);
    expect(host.textContent).toContain('per minute');
    expect(host.querySelector<HTMLInputElement>('#rec-title')?.maxLength).toBe(48);
  });
});
