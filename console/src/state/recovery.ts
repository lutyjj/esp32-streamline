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
  /** Contact ended; a rejoin restart closes the setup network, and so do other things. */
  | { kind: 'left'; text: string };

/** What the latest join attempt says about the saved network. */
function recoveryCause(s: StatusResponse): string {
  const ssid = s.wifi.ssid;
  switch (s.wifi.join_failure) {
    case 'network-not-found':
      return `StreamLine can’t find ${ssid}.`;
    case 'credentials-rejected':
      return `${ssid} didn’t accept the saved password, or its signal is too weak to finish joining.`;
    case 'security-mismatch':
      return `${ssid} doesn’t accept the security saved for it: it may have added or removed its password, or it uses a security mode StreamLine can’t join.`;
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
      text: `Lost contact with StreamLine. If its setup network is gone, it has probably rejoined ${ssid}: reconnect to ${ssid}, then open http://${s.wifi.hostname}/ to confirm.`,
    };
  }
  const retry =
    s.wifi.join_failure === 'credentials-rejected'
      ? 'It keeps retrying every minute; if the password changed, enter the new one.'
      : s.wifi.join_failure === 'security-mismatch'
        ? 'It keeps retrying every minute; if the network’s password changed, update the saved details.'
        : 'It retries every minute and rejoins on its own when the network is back.';
  return { kind: 'retrying', text: `${recoveryCause(s)} ${retry}` };
}

/** The recovery story for the last status read; a failed poll keeps that status. */
export const recovery = computed(() => recoveryStory(status.value, unreachable.value));
