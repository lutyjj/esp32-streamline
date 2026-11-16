/**
 * The bridge target form: what it opens on, what Use and a save change, and
 * the save. The target is the device's; the bridge console address beside it
 * stays in this browser.
 */

import { type DiscoveredBridge, setTarget } from '../lib/api';
import { BRIDGE_PORT, type TargetEntry, targetRequest } from '../lib/target';
import { withRestart } from './access';
import { rememberBridgeConsole, rememberedBridgeConsole } from './bridgeConsole';
import { bridgeConsoleAddress } from './discovery';

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

/** The form as it opens: the saved target, and the console address this browser keeps for it. */
export function savedDraft(target: SavedTarget | undefined): TargetDraft {
  const host = target?.target_host ?? '';
  return {
    entry: { host, port: String(host ? target?.target_port : BRIDGE_PORT) },
    console: host ? rememberedBridgeConsole(`${host}:${target?.target_port}`) : '',
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
