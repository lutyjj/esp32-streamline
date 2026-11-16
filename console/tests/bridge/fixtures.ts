/**
 * Bridge fixtures from the contract's examples, which the bridge publishes
 * and checks against its models; tests override what they need.
 */

import contract from '../../../docs/bridge-openapi.json';
import type {
  BridgeStatus,
  RecordingCapabilities,
  RecordingList,
  SendspinSourceSnapshot,
  SourceSnapshot,
} from '../../src/generated/bridge';

const schemas = contract.components.schemas;

export const SOURCE = Object.keys(schemas.BridgeStatus.examples[0].sources)[0] as string;

export function bridgeStatus(): BridgeStatus {
  return structuredClone(schemas.BridgeStatus.examples[0]) as BridgeStatus;
}

export function source(changes: Partial<SourceSnapshot> = {}): SourceSnapshot {
  return { ...(bridgeStatus().sources[SOURCE] as SourceSnapshot), ...changes };
}

export function published(changes: Partial<SendspinSourceSnapshot> = {}): SendspinSourceSnapshot {
  return { ...(bridgeStatus().sendspin.sources[0] as SendspinSourceSnapshot), ...changes };
}

export function recordingList(): RecordingList {
  return structuredClone(schemas.RecordingList.examples[0]) as RecordingList;
}

export function capabilities(): RecordingCapabilities {
  return structuredClone(schemas.RecordingCapabilities.examples[0]) as RecordingCapabilities;
}
