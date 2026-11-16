import { useQuery } from '@tanstack/preact-query';
import { ChipTrigger, type Crumb, TopBar } from 'linen';
import type { ReactNode } from 'react';
import { AccessChip } from '../../shared/AccessChip';
import { navigate } from '../../shared/navigation';
import { queryClient } from '../../shared/queries';
import { whereToSet } from '../lib/deployment';
import { forgetBridgeToken, heldToken } from '../lib/token';
import { statusQuery } from '../state/queries';

/** Every screen's top bar: its title, what it is doing, and the access chip. */
export function ScreenTop({
  title,
  meta,
  trail,
}: {
  title: string;
  meta?: ReactNode;
  trail?: readonly Crumb[];
}) {
  return (
    <TopBar title={title} meta={meta} trail={trail}>
      <BridgeAccess />
    </TopBar>
  );
}

function BridgeAccess() {
  const status = useQuery(statusQuery, queryClient);
  if (!status.data) return null;
  // Without a token in the deployment, nothing here can change, and no unlock would help.
  if (!status.data.api_token_configured)
    return (
      <ChipTrigger
        aria-label={`Read-only. Set ${whereToSet('token')} to make changes`}
        onClick={() => navigate('/settings/deployment')}
      >
        Read-only
      </ChipTrigger>
    );
  return (
    <AccessChip until={heldToken.value ? null : 0} subject="Bridge" onLock={forgetBridgeToken} />
  );
}
