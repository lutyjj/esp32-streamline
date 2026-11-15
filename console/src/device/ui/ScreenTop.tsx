import { COLUMN_CLASS, type Crumb, classes, LINK_CLASS, TopBar } from 'linen';
import type { ReactNode } from 'react';
import { AccessChip } from '../../shared/AccessChip';
import { Link } from '../../shared/navigation';
import { lockSettings, storedAdminKey, unlockUntil, useAuthEpoch } from '../lib/adminKey';
import { connection, status } from '../state/device';
import { deviceNotice } from '../state/notice';

/**
 * Every screen's top: its title and the access chip, then the page-wide
 * notice while contact with the device is anything but live.
 */
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
    <>
      <TopBar title={title} meta={meta} trail={trail}>
        <DeviceAccess />
      </TopBar>
      <DeviceNotice />
    </>
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

const TONE_CLASS = {
  progress: 'text-text-secondary',
  attention: 'text-warn',
  failure: 'text-danger',
} as const;

/** Stand-in for linen's page-wide condition, which is still to come. */
function DeviceNotice() {
  const notice = deviceNotice(connection.value);
  if (!notice) return null;
  return (
    <p role="status" className={classes(COLUMN_CLASS, 'pt-4 text-sm', TONE_CLASS[notice.tone])}>
      {notice.text}
      {notice.action === 'change-wifi' && (
        <>
          {' '}
          <Link className={LINK_CLASS} href="/device/wifi">
            Change Wi-Fi
          </Link>
        </>
      )}
    </p>
  );
}
