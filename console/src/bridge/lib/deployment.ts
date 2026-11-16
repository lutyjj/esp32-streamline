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

/** The container option that keeps audio security's state; the app always sets it. */
export const TRANSPORT_STATE_OPTION = '--transport-state-file';
