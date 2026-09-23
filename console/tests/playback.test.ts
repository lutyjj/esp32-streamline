import { expect, it } from 'vitest';
import { playbackUrl } from '../src/bridge/playback';
import { consoleAddress } from '../src/lib/consoleAddress';

it('uses the advertised player address rather than authenticated ingress', () => {
  expect(
    playbackUrl(
      'http://192.0.2.20:8099',
      '/api/hassio_ingress/session',
      'https://home.example',
      'source B',
    ),
  ).toBe('http://192.0.2.20:8099/streamline.wav?source=source+B');
  expect(
    playbackUrl('', '/api/hassio_ingress/session', 'https://home.example', 'B'),
  ).toBeUndefined();
});

it('supports a direct bridge and rejects credential-bearing addresses', () => {
  expect(playbackUrl('', '', 'http://192.0.2.20:8088', 'B')).toBe(
    'http://192.0.2.20:8088/streamline.wav?source=B',
  );
  expect(playbackUrl('https://secret@example.com', '', 'http://localhost', 'B')).toBeUndefined();
  expect(consoleAddress('javascript:alert(1)')).toBeUndefined();
  expect(consoleAddress('http://bridge.local:8099')).toBe('http://bridge.local:8099/#/sources');
});
