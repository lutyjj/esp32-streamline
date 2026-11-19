/**
 * The deployment options the console points to, as the Home Assistant app
 * and a container name them. The bridge reads them at start, so each is
 * changed in the deployment and the bridge restarted.
 */

const OPTIONS = {
  token: { app: 'api_token', container: 'STREAMLINE_API_TOKEN' },
  recordings: { app: 'recordings_enabled', container: '--recordings-dir' },
  publicUrl: { app: 'public_url', container: '--public-url' },
  sendspin: { app: 'sendspin_server_url', container: '--sendspin-server-url' },
} as const;

export type DeploymentOption = keyof typeof OPTIONS;

/** Where `option` is set, for the middle of a sentence. */
export function whereToSet(option: DeploymentOption): string {
  const { app, container } = OPTIONS[option];
  return `${app} in the Home Assistant app's configuration, or ${container} for a container`;
}

/** Why `change` is not offered on a bridge whose deployment sets no token, and where it is set. */
export function tokenNeeded(change: string): string {
  return `${change} needs the bridge API token. Set ${whereToSet('token')}, then restart the bridge.`;
}

/** The container option that keeps audio security's state; the app always sets it. */
export const TRANSPORT_STATE_OPTION = '--transport-state-file';

/**
 * Why the listener's mode cannot change here, or nothing where it can: a
 * deployment that keeps no state for it says so before a missing token does,
 * since a token would not help.
 */
export function listenerHeld(configurable: boolean, readOnly: boolean): string {
  if (!configurable)
    return `Audio security needs a place to keep its state. Set ${TRANSPORT_STATE_OPTION} for a container, then restart the bridge; the Home Assistant app sets it.`;
  return readOnly ? tokenNeeded('Changing audio security') : '';
}
