/**
 * Recovery: a provisioned device that cannot join its saved Wi-Fi serves this
 * console on its setup network and keeps retrying. The banner names the cause
 * and the next step on every page.
 */

import { computed } from '@preact/signals';
import type { StatusResponse } from '../lib/api';
import { status, unreachable } from './device';

export type RecoveryStory =
  /** The device answers on its setup network while it retries. */
  | { kind: 'retrying'; text: string }
  /** The setup network went away, which a rejoin restart causes. */
  | { kind: 'left'; text: string };

/** What the latest join attempt says about the saved network. */
function recoveryCause(s: StatusResponse): string {
  const ssid = s.wifi.ssid;
  switch (s.wifi.join_failure) {
    case 'network-not-found':
      return `StreamLine can’t find ${ssid}.`;
    case 'credentials-rejected':
      return `${ssid} rejected the saved password.`;
    default:
      return `StreamLine can’t join ${ssid}.`;
  }
}

export function recoveryStory(s: StatusResponse | null, lost: boolean): RecoveryStory | null {
  if (s?.mode !== 'recovery') return null;
  const ssid = s.wifi.ssid;
  if (lost) {
    return {
      kind: 'left',
      text: `The setup network closed, which usually means StreamLine rejoined ${ssid}. Reconnect to ${ssid}, then open http://${s.wifi.hostname}/ to confirm.`,
    };
  }
  const retry =
    s.wifi.join_failure === 'credentials-rejected'
      ? 'It keeps retrying every minute; if the password changed, enter the new one.'
      : 'It retries every minute and rejoins on its own when the network is back.';
  return { kind: 'retrying', text: `${recoveryCause(s)} ${retry}` };
}

/** The recovery story for the last status read; a failed poll keeps that status. */
export const recovery = computed(() => recoveryStory(status.value, unreachable.value));
