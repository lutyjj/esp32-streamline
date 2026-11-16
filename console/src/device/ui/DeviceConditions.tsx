import { buttonClass, Condition, Elapsed, type Tone } from 'linen';
import { Link } from '../../shared/navigation';
import { connection } from '../state/device';
import { deviceNotice, type NoticeTone } from '../state/notice';

const TONE: Record<NoticeTone, Tone> = {
  progress: 'accent',
  attention: 'warn',
  failure: 'danger',
};

/** The condition that holds across every screen while contact is anything but live. */
export function DeviceConditions() {
  const notice = deviceNotice(connection.value);
  if (!notice) return null;
  return (
    <Condition
      tone={TONE[notice.tone]}
      active={notice.tone === 'progress'}
      title={notice.title}
      description={
        notice.since === undefined ? (
          notice.description
        ) : (
          <>
            {notice.description} <Elapsed since={notice.since} />
          </>
        )
      }
      action={
        notice.action === 'change-wifi' ? (
          <Link className={buttonClass()} href="/device/wifi">
            Change Wi-Fi
          </Link>
        ) : undefined
      }
    />
  );
}
