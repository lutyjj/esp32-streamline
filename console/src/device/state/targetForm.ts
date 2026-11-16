/**
 * The bridge target form: what it opens on, what keeps it from going, what
 * Use and a save change, and the save. The target is the device's; the bridge
 * console address beside it stays in this browser.
 */

import * as v from 'valibot';
import { type DiscoveredBridge, setTarget, type TargetSettingsRequest } from '../../generated/api';
import { TargetSettingsRequest as targetRule } from '../../generated/rules';
import { withRestart } from './access';
import { rememberBridgeConsole, rememberedBridgeConsole } from './bridgeConsole';
import { bridgeConsoleAddress } from './discovery';

/** The bridge host and port as the owner typed them. */
export interface TargetEntry {
  host: string;
  port: string;
}

/** The request fields the target form names its fields after. */
export const TARGET_FIELDS = ['target_host', 'target_port'] as const;

/** The fields a target save sends. */
export function targetRequest(entry: TargetEntry): Required<TargetSettingsRequest> {
  return { target_host: entry.host.trim(), target_port: Number(entry.port.trim()) };
}

/** Why `value` cannot be the bridge's host, or null. */
export function hostProblem(value: string): string | null {
  const host = value.trim();
  // The contract lets an empty host clear the target; this form connects one.
  if (host === '') return 'Enter the bridge’s name or address.';
  return v.is(targetRule.entries.target_host, host)
    ? null
    : 'Enter only the name or address, without http://, a port, a path or spaces.';
}

/** Why the contract refuses `value` as the bridge's port, or null. */
export function portProblem(value: string): string | null {
  return v.is(targetRule.entries.target_port, Number(value.trim()))
    ? null
    : 'A port is a number from 1 to 65535.';
}

/** Whether the target fields already name this bridge. */
export function fillsTarget(bridge: DiscoveredBridge, host: string, port: string): boolean {
  return host.trim() === bridge.host && Number(port) === bridge.port;
}

/**
 * The console address Use fills in, or null to keep the field: the bridge's
 * own replaces an empty field or one an earlier Use filled (`filled`), never
 * an address the owner typed.
 */
export function consoleAddressAfterUse(
  current: string,
  filled: string,
  bridge: DiscoveredBridge,
): string | null {
  return current === '' || current === filled ? bridgeConsoleAddress(bridge) : null;
}

/** The target form: the entry, and the bridge console address beside it. */
export interface TargetDraft {
  entry: TargetEntry;
  console: string;
  /** The console address the last Use filled, so the next one may replace it. */
  consoleFilled: string;
}

/** The device's saved target, as the form opens on it. */
export interface SavedTarget {
  target_host: string;
  target_port: number;
}

/**
 * The form as it opens: the saved target, and the console address this
 * browser keeps for it. A device with no bridge still reports the port it
 * would send to.
 */
export function savedDraft(target: SavedTarget): TargetDraft {
  const host = target.target_host;
  return {
    entry: { host, port: String(target.target_port) },
    console: host ? rememberedBridgeConsole(`${host}:${target.target_port}`) : '',
    consoleFilled: '',
  };
}

/** What a save of the form would change: the device's target, this browser's console address. */
export function draftChanges(
  draft: TargetDraft,
  saved: TargetDraft,
): { target: boolean; console: boolean } {
  return {
    target:
      draft.entry.host.trim() !== saved.entry.host || draft.entry.port.trim() !== saved.entry.port,
    console: draft.console.trim() !== saved.console,
  };
}

/**
 * Keep the form. A new target goes to the device, which restarts to send
 * there; a console address alone writes nothing to the device. Resolves
 * false when the owner declines to unlock, and nothing is kept.
 */
export async function saveTarget(draft: TargetDraft, saved: TargetDraft): Promise<boolean> {
  const request = targetRequest(draft.entry);
  if (draftChanges(draft, saved).target) {
    const ack = await withRestart('the bridge change', () => setTarget(request));
    if (ack === null) return false;
  }
  rememberBridgeConsole(`${request.target_host}:${request.target_port}`, draft.console.trim());
  return true;
}

/** The form after Use: a found bridge fills the fields, and nothing is saved. */
export function adoptFound(draft: TargetDraft, bridge: DiscoveredBridge): TargetDraft {
  const filled = consoleAddressAfterUse(draft.console, draft.consoleFilled, bridge);
  return {
    entry: { host: bridge.host, port: String(bridge.port) },
    console: filled ?? draft.console,
    consoleFilled: filled ?? draft.consoleFilled,
  };
}
