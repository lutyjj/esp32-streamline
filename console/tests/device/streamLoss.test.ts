import { beforeEach, describe, expect, it } from 'vitest';
import { deviceStatus } from '../../src/device/mocks/fixtures';
import {
  CLEAR_AFTER_POLLS,
  cleanPolls,
  episodeDrops,
  lastDropTotal,
  lossCalloutVisible,
} from '../../src/device/state/streamLoss';
import { answering } from './answering';

function withDrops(queue: number, mode: 'setup' | 'provisioned' = 'provisioned') {
  return deviceStatus({
    mode,
    metrics: { queue_drops_total: queue },
  });
}

beforeEach(() => {
  answering(null);
  lastDropTotal.value = null;
  episodeDrops.value = 0;
  cleanPolls.value = 0;
});

describe('stream loss callout', () => {
  it('separates intentional silence from capture loss', () => {
    answering(deviceStatus({ metrics: { silence_packets_total: 10 } }));
    answering(deviceStatus({ metrics: { silence_packets_total: 1000 } }));
    expect(lossCalloutVisible.value).toBe(false);
    answering(deviceStatus({ metrics: { capture_lost_packets_total: 2 } }));
    expect(lossCalloutVisible.value).toBe(true);
    expect(episodeDrops.value).toBe(2);
  });
  it('stays hidden without status and on the first poll, whatever its total', () => {
    expect(lossCalloutVisible.value).toBe(false);
    answering(withDrops(500));
    expect(lossCalloutVisible.value).toBe(false);
  });

  it('shows when the drop counters grow between polls', () => {
    answering(withDrops(500));
    answering(withDrops(530));
    expect(lossCalloutVisible.value).toBe(true);
    expect(episodeDrops.value).toBe(30);
  });

  it('counts affected packets rather than failed-send events', () => {
    answering(
      deviceStatus({
        metrics: { network_errors_total: 2, send_failed_packets_total: 8 },
      }),
    );
    answering(
      deviceStatus({
        metrics: { network_errors_total: 3, send_failed_packets_total: 12 },
      }),
    );
    expect(lossCalloutVisible.value).toBe(true);
    expect(episodeDrops.value).toBe(4);
  });

  it('accumulates across bursts and survives clean polls in between', () => {
    answering(withDrops(0));
    answering(withDrops(30));
    answering(withDrops(30));
    answering(withDrops(75));
    expect(episodeDrops.value).toBe(75);
    expect(lossCalloutVisible.value).toBe(true);
  });

  it('clears only after the stream stays clean for the full window', () => {
    answering(withDrops(0));
    answering(withDrops(12));
    for (let i = 0; i < CLEAR_AFTER_POLLS - 1; i += 1) {
      answering(withDrops(12));
      expect(lossCalloutVisible.value).toBe(true);
    }
    answering(withDrops(12));
    expect(lossCalloutVisible.value).toBe(false);
  });

  it('does not blame a reboot counter reset for new loss', () => {
    answering(withDrops(500));
    answering(withDrops(0));
    expect(lossCalloutVisible.value).toBe(false);
    answering(withDrops(8));
    expect(lossCalloutVisible.value).toBe(true);
  });

  it('never shows in setup mode', () => {
    answering(withDrops(0, 'setup'));
    answering(withDrops(40, 'setup'));
    expect(lossCalloutVisible.value).toBe(false);
  });
});
