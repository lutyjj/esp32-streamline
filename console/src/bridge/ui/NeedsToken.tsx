import { whereToSet } from '../lib/deployment';

/** Why a change is not offered on a bridge whose deployment sets no token, and where it is set. */
export function NeedsToken({ change }: { change: string }) {
  return (
    <p className="max-w-prose text-sm text-text-secondary">
      {change} needs the bridge API token. Set {whereToSet('token')}, then restart the bridge.
    </p>
  );
}
