/**
 * Device fixtures derived from the contract's canonical example device: the
 * artifact's `StatusResponse` and `SettingsResponse` schema examples (built by
 * the firmware from its real DTOs), plus the deep-merge overrides unit tests
 * and the fake device layer on top. The typed bindings below are the drift
 * gate: an example that stops satisfying the generated types fails `tsc`.
 */

import contract from '../../../docs/openapi.json';
import type {
  SettingsResponse,
  SetupNetworkResponse,
  StatusResponse,
  TransportStatus,
} from '../lib/api';

// A single narrowing cast, not `as unknown`: JSON imports widen enum values
// to `string`, but the structures must still line up, so a missing or
// mistyped example field fails `tsc` here.
const STATUS_EXAMPLE = contract.components.schemas.StatusResponse.example as StatusResponse;
const CONFIG_EXAMPLE = contract.components.schemas.SettingsResponse.example as SettingsResponse;
const SETUP_NETWORK_EXAMPLE = contract.components.schemas.SetupNetworkResponse
  .example as SetupNetworkResponse;

/** The example device's setup network, so its SSID shape follows the firmware's. */
export function setupNetwork(overrides: Partial<SetupNetworkResponse> = {}): SetupNetworkResponse {
  return { ...structuredClone(SETUP_NETWORK_EXAMPLE), ...overrides };
}

/** The example device's cleartext transport; override the fields a test cares about. */
export function transportStatus(overrides: Partial<TransportStatus> = {}): TransportStatus {
  return { ...structuredClone(CONFIG_EXAMPLE.transport), ...overrides };
}

/** The example device's stored settings; override the fields the test cares about. */
export function deviceConfig(overrides: Partial<SettingsResponse> = {}): SettingsResponse {
  return { ...structuredClone(CONFIG_EXAMPLE), ...overrides };
}

/**
 * The example device: healthy, provisioned, streaming. Override the fields
 * the test cares about; nested `wifi`/`metrics`/… overrides merge into the
 * example's values.
 */
export function deviceStatus(
  overrides: Partial<
    Omit<
      StatusResponse,
      'wifi' | 'target' | 'audio' | 'metrics' | 'diagnostics' | 'system' | 'ota' | 'health'
    >
  > & {
    wifi?: Partial<StatusResponse['wifi']>;
    target?: Partial<StatusResponse['target']>;
    audio?: Partial<StatusResponse['audio']>;
    metrics?: Partial<StatusResponse['metrics']>;
    diagnostics?: Partial<StatusResponse['diagnostics']>;
    system?: Partial<StatusResponse['system']>;
    ota?: Partial<StatusResponse['ota']>;
    health?: Partial<StatusResponse['health']>;
  } = {},
): StatusResponse {
  const { wifi, target, audio, metrics, diagnostics, system, ota, health, ...top } = overrides;
  const base = structuredClone(STATUS_EXAMPLE);
  return {
    ...base,
    wifi: { ...base.wifi, ...wifi },
    target: { ...base.target, ...target },
    audio: { ...base.audio, ...audio },
    metrics: { ...base.metrics, ...metrics },
    diagnostics: { ...base.diagnostics, ...diagnostics },
    system: { ...base.system, ...system },
    ota: { ...base.ota, ...ota },
    health: { ...base.health, ...health },
    ...top,
  };
}
