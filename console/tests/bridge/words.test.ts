import { describe, expect, it } from 'vitest';
import { whereToSet } from '../../src/bridge/lib/deployment';
import { musicAssistantStep } from '../../src/bridge/lib/musicAssistant';
import { playbackUrl } from '../../src/bridge/lib/playback';
import { quality, receptionAdvice, sourceState } from '../../src/bridge/lib/reception';
import { recordingRoom, titleProblem } from '../../src/bridge/state/recordings';
import { keyIdProblem, pskProblem } from '../../src/bridge/state/security';
import { capabilities, published, recordingList, source } from './fixtures';

describe('the playback address', () => {
  it('uses the public URL the bridge advertises', () => {
    expect(playbackUrl('http://192.0.2.20:8088/', 'http://192.0.2.5:8088/', '192.0.2.10')).toBe(
      'http://192.0.2.20:8088/streamline.wav?source=192.0.2.10',
    );
  });

  it('falls back to the origin of a page served at the bridge’s root', () => {
    expect(playbackUrl('', 'http://192.0.2.20:8088/#/sources', 'eli1-x')).toBe(
      'http://192.0.2.20:8088/streamline.wav?source=eli1-x',
    );
  });

  it('has none for a page under a prefix, such as an ingress', () => {
    expect(playbackUrl('', 'http://ha.example/api/hassio_ingress/abc/', 's')).toBeUndefined();
  });
});

describe('reception', () => {
  it('meets the target over a full minute of audio', () => {
    expect(quality(source())).toEqual({ tone: 'positive', label: 'Target met' });
    expect(sourceState(source())).toEqual({ tone: 'positive', label: 'Receiving' });
  });

  it('misses it with two missing intervals, an underrun or a drop', () => {
    for (const miss of [{ missing_packets: 2 }, { underruns: 1 }, { disconnects: 1 }]) {
      const late = source();
      late.quality = { ...late.quality, ...miss };
      expect(quality(late).label).toBe('Target not met');
    }
  });

  it('measures before a full minute and does not judge a quiet one', () => {
    const young = source();
    young.quality = { ...young.quality, observed_seconds: 12.5 };
    const quiet = source({ signal: 'absent' });
    quiet.quality = { ...quiet.quality, audio_packets: 0, silence_packets: 11250 };

    expect(quality(young).label).toBe('Measuring, 12 of 60 s');
    expect(quality(quiet).label).toBe('Quiet input, not measured');
    expect(sourceState(quiet).label).toBe('Quiet input');
    expect(receptionAdvice(quiet)).toMatch(/quiet input/);
  });

  it('names a player falling behind before anything else', () => {
    const slow = source();
    slow.client_streams = slow.client_streams.map((client) => ({ ...client, queue_depth: 2000 }));
    expect(receptionAdvice(slow)).toMatch(/A player is falling behind/);
  });
});

describe('the Music Assistant step', () => {
  it('leads with pairing until the source is paired', () => {
    expect(musicAssistantStep(published())).toMatchObject({ label: 'Needs pairing', pairs: true });
  });

  it('follows connection, input and playback', () => {
    expect(musicAssistantStep(published({ connection: 'connecting' })).label).toBe('Connecting');
    expect(musicAssistantStep(published({ paired: true })).label).toBe('Input off');
    const ready = published({ paired: true, input_enabled: true });
    expect(musicAssistantStep(ready).label).toBe('Ready');
    expect(musicAssistantStep({ ...ready, streaming: true }).label).toBe('Playing');
  });
});

describe('recording', () => {
  it('has room for what lies above the bridge’s storage floor', () => {
    const list = recordingList();
    const limits = capabilities();
    list.storage.free_bytes = limits.limits.min_free_bytes + 60 * limits.format.bytes_per_second;

    expect(recordingRoom(list, limits)).toBe(60);
    list.storage.free_bytes = 0;
    expect(recordingRoom(list, limits)).toBe(0);
  });
});

describe('the contract’s rules in the console’s words', () => {
  it('want a visible title within the limit', () => {
    expect(titleProblem('Side A', 80)).toBeNull();
    expect(titleProblem('   ', 80)).toMatch(/at most 80/);
    expect(titleProblem('x'.repeat(81), 80)).toMatch(/at most 80/);
  });

  it('want a credential as the device console shows it', () => {
    expect(keyIdProblem(`eli1-${'0'.repeat(32)}`)).toBeNull();
    expect(keyIdProblem('eli1-XYZ')).toMatch(/eli1-/);
    expect(pskProblem('a'.repeat(64))).toBeNull();
    expect(pskProblem('A'.repeat(64))).toMatch(/64 lowercase/);
  });

  it('name where an option is set in both deployments', () => {
    expect(whereToSet('token')).toBe(
      "api_token in the Home Assistant app's configuration, or STREAMLINE_API_TOKEN for a container",
    );
  });
});
