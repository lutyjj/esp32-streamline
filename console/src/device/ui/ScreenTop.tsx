import { type Crumb, TopBar } from 'linen';
import type { ReactNode } from 'react';
import { AccessChip } from '../../shared/AccessChip';
import { lockSettings, storedAdminKey, unlockUntil, useAuthEpoch } from '../lib/adminKey';
import { status } from '../state/device';

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
      <DeviceAccess />
    </TopBar>
  );
}

function DeviceAccess() {
  useAuthEpoch();
  // A device without a key yet takes writes from anyone on its setup network.
  if (status.value?.auth_required === false) return null;
  return (
    <AccessChip
      until={storedAdminKey() ? unlockUntil() : 0}
      subject="Settings"
      onLock={lockSettings}
    />
  );
}
