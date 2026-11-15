/**
 * The bridge console's address, which only the owner or a bridge's own
 * advertisement can give. This browser keeps it beside the target it belongs
 * to, so a new target never links to the old bridge.
 */

import { localStore } from '../../shared/custody';

const STORAGE_KEY = 'streamline:bridge-console';

/** The address kept for `target` (`host:port`), or '' when none is. */
export function rememberedBridgeConsole(target: string): string {
  try {
    const kept = JSON.parse(localStore.get(STORAGE_KEY) || 'null') as {
      target?: unknown;
      address?: unknown;
    } | null;
    return kept?.target === target && typeof kept.address === 'string' ? kept.address : '';
  } catch {
    return '';
  }
}

export function rememberBridgeConsole(target: string, address: string): void {
  if (address.trim() === '') localStore.remove(STORAGE_KEY);
  else localStore.set(STORAGE_KEY, JSON.stringify({ target, address: address.trim() }));
}
