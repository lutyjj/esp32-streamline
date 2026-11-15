import { afterEach, describe, expect, it } from 'vitest';
import { deviceConfig, deviceStatus, transportStatus } from '../../src/device/mocks/fixtures';
import {
  rememberBridgeConsole,
  rememberedBridgeConsole,
} from '../../src/device/state/bridgeConsole';
import { delivery } from '../../src/device/state/delivery';

describe('delivery', () => {
  it('says nothing without a bridge', () => {
    expect(delivery(deviceStatus({ target: { target_host: '' } }), deviceConfig())).toBeNull();
  });

  it('names the target and the source as the bridge knows it in the clear', () => {
    const facts = delivery(
      deviceStatus({
        target: { target_host: '192.0.2.20', target_port: 39000 },
        wifi: { sta_ip: '192.0.2.10' },
        metrics: {
          reconnects_total: 2,
          queue_drops_total: 3,
          capture_lost_packets_total: 4,
          send_failed_packets_total: 5,
        },
      }),
      deviceConfig({ transport: transportStatus({ mode: 'cleartext' }) }),
    );
    expect(facts).toMatchObject({
      address: '192.0.2.20:39000',
      encrypted: false,
      source: '192.0.2.10',
      reconnects: 2,
      dropped: 12,
    });
  });

  it('names the source by its key id once encrypted', () => {
    const facts = delivery(
      deviceStatus(),
      deviceConfig({ transport: transportStatus({ mode: 'tls-psk', active_key_id: 'eli1-00ab' }) }),
    );
    expect(facts).toMatchObject({ encrypted: true, source: 'eli1-00ab' });
  });
});

describe('the remembered bridge console', () => {
  afterEach(() => localStorage.clear());

  it('belongs to the target it was given for', () => {
    rememberBridgeConsole('192.0.2.20:39000', ' http://192.0.2.20:8088/ ');
    expect(rememberedBridgeConsole('192.0.2.20:39000')).toBe('http://192.0.2.20:8088/');
    expect(rememberedBridgeConsole('192.0.2.21:39000')).toBe('');
  });

  it('forgets on a blank address and survives a corrupt entry', () => {
    rememberBridgeConsole('192.0.2.20:39000', 'http://192.0.2.20:8088/');
    rememberBridgeConsole('192.0.2.20:39000', '');
    expect(rememberedBridgeConsole('192.0.2.20:39000')).toBe('');
    localStorage.setItem('streamline:bridge-console', '{not json');
    expect(rememberedBridgeConsole('192.0.2.20:39000')).toBe('');
  });
});
