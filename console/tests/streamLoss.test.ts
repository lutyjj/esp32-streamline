import { beforeEach, describe, expect, it } from 'vitest';
import { deviceStatus } from '../src/mocks/fixtures';
import { status } from '../src/state/device';
import {
  CLEAR_AFTER_POLLS,
  cleanPolls,
  episodeDrops,
  lastDropTotal,
  lossCalloutVisible,
} from '../src/state/streamLoss';

function withDrops(queue: number, mode: 'setup' | 'provisioned' = 'provisioned') {
  return deviceStatus({
    mode,
    metrics: { queue_drops_total: queue },
  });
}

beforeEach(() => {
  status.value = null;
  lastDropTotal.value = null;
  episodeDrops.value = 0;
  cleanPolls.value = 0;
});

describe('stream loss callout', () => {
  it('separates intentional silence from capture loss', () => {
    status.value = deviceStatus({ metrics: { silence_packets_total: 10 } });
    status.value = deviceStatus({ metrics: { silence_packets_total: 1000 } });
    expect(lossCalloutVisible.value).toBe(false);
    status.value = deviceStatus({ metrics: { capture_lost_packets_total: 2 } });
    expect(lossCalloutVisible.value).toBe(true);
    expect(episodeDrops.value).toBe(2);
  });
  it('stays hidden without status and on the first poll, whatever its total', () => {
    expect(lossCalloutVisible.value).toBe(false);
    status.value = withDrops(500);
    expect(lossCalloutVisible.value).toBe(false);
  });

  it('shows when the drop counters grow between polls', () => {
    status.value = withDrops(500);
    status.value = withDrops(530);
    expect(lossCalloutVisible.value).toBe(true);
    expect(episodeDrops.value).toBe(30);
  });

  it('counts affected packets rather than failed-send events', () => {
    status.value = deviceStatus({
      metrics: { network_errors_total: 2, send_failed_packets_total: 8 },
    });
    status.value = deviceStatus({
      metrics: { network_errors_total: 3, send_failed_packets_total: 12 },
    });
    expect(lossCalloutVisible.value).toBe(true);
    expect(episodeDrops.value).toBe(4);
  });

  it('accumulates across bursts and survives clean polls in between', () => {
    status.value = withDrops(0);
    status.value = withDrops(30);
    status.value = withDrops(30);
    status.value = withDrops(75);
    expect(episodeDrops.value).toBe(75);
    expect(lossCalloutVisible.value).toBe(true);
  });

  it('clears only after the stream stays clean for the full window', () => {
    status.value = withDrops(0);
    status.value = withDrops(12);
    for (let i = 0; i < CLEAR_AFTER_POLLS - 1; i += 1) {
      status.value = withDrops(12);
      expect(lossCalloutVisible.value).toBe(true);
    }
    status.value = withDrops(12);
    expect(lossCalloutVisible.value).toBe(false);
  });

  it('does not blame a reboot counter reset for new loss', () => {
    status.value = withDrops(500);
    status.value = withDrops(0);
    expect(lossCalloutVisible.value).toBe(false);
    status.value = withDrops(8);
    expect(lossCalloutVisible.value).toBe(true);
  });

  it('never shows in setup mode', () => {
    status.value = withDrops(0, 'setup');
    status.value = withDrops(40, 'setup');
    expect(lossCalloutVisible.value).toBe(false);
  });
});
