import { describe, expect, it } from 'vitest';
import { deviceStatus } from '../../src/device/mocks/fixtures';
import { UPDATE_OPERATION } from '../../src/device/state/connection';
import type { SettledRestart } from '../../src/device/state/device';
import { installProgress, updateNews } from '../../src/device/state/ota';
import type { InstallResult } from '../../src/generated/api';

describe('update news', () => {
  const settled = (result: InstallResult, after: string): SettledRestart => ({
    operation: UPDATE_OPERATION,
    before: deviceStatus({ firmware_version: '0.4.0' }),
    after: deviceStatus({ firmware_version: after, ota: { last_result: result } }),
  });

  it('names the version an install reached', () => {
    expect(updateNews(settled('installed', '0.5.0'))).toEqual({
      text: 'Updated to 0.5.0.',
      failure: false,
    });
  });

  it('marks a rollback as a failure and names the version that runs', () => {
    const news = updateNews(settled('rolled-back', '0.4.0'));
    expect(news.failure).toBe(true);
    expect(news.text).toContain('went back to 0.4.0');
  });

  it('marks an install the restart cut short as a failure', () => {
    const news = updateNews(settled('failed', '0.4.0'));
    expect(news.failure).toBe(true);
    expect(news.text).toContain('still runs 0.4.0');
  });

  it('holds the result even when the new image carries the same version', () => {
    // A rebuilt image can keep its version; the device knows which slot it wrote.
    expect(updateNews(settled('installed', '0.4.0')).text).toBe('Updated to 0.4.0.');
  });
});

describe('install progress', () => {
  it('shares the bytes written only while downloading', () => {
    const downloading = deviceStatus({
      ota: { phase: 'downloading', bytes_written: 512, bytes_total: 2048 },
    });
    expect(installProgress(downloading)).toEqual({ words: 'Downloading…', fraction: 0.25 });
    const verifying = deviceStatus({
      ota: { phase: 'verifying', bytes_written: 2048, bytes_total: 2048 },
    });
    expect(installProgress(verifying)).toEqual({ words: 'Verifying…', fraction: null });
  });
});
