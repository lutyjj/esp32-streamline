/**
 * What the device can say about delivery to its bridge: where it sends, how,
 * and how the link has held since the device started. These are the
 * sender's facts; whether audio arrives is the bridge's to show.
 */

import type { SettingsResponse, StatusResponse } from '../lib/api';

export interface Delivery {
  /** The target as `host:port`. */
  address: string;
  encrypted: boolean;
  /**
   * How the bridge names this device's source: its address in the clear, its
   * key id once encrypted. Null until the device knows it.
   */
  source: string | null;
  reconnects: number;
  networkErrors: number;
  handshakeFailures: number;
  longestStallMs: number;
  /** Packets lost to a full queue, a short capture read or a failed send. */
  dropped: number;
}

/** Null while the device has no bridge to send to. */
export function delivery(
  status: StatusResponse,
  settings: SettingsResponse | null,
): Delivery | null {
  const { target_host: host, target_port: port } = status.target;
  if (!host) return null;
  const transport = settings?.transport;
  const encrypted = transport?.mode === 'tls-psk';
  const source = encrypted ? (transport?.active_key_id ?? null) : status.wifi.sta_ip || null;
  const m = status.metrics;
  return {
    address: `${host}:${port}`,
    encrypted,
    source,
    reconnects: m.reconnects_total,
    networkErrors: m.network_errors_total,
    handshakeFailures: m.tls_handshake_failures_total,
    longestStallMs: m.longest_send_stall_ms,
    dropped: m.queue_drops_total + m.capture_lost_packets_total + m.send_failed_packets_total,
  };
}
