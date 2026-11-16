import { ChipTrigger } from 'linen';
import { useEffect, useState } from 'react';
import { requestCredential } from './credentialGate';

/** How often the chip reads the clock again. */
const TICK_MS = 15_000;

/**
 * Whether this console's writes are unlocked, on every screen. Locked, it
 * opens the credential dialog; unlocked, it says for how long where the
 * unlock ends by itself, and locks.
 */
export function AccessChip({
  until,
  subject,
  onLock,
}: {
  /** When the unlock window closes, any time past meaning locked; null holds it until locked. */
  until: number | null;
  /** What unlocking opens, for the control's name, such as "Settings". */
  subject: string;
  onLock: () => void;
}) {
  const [, setTicks] = useState(0);
  useEffect(() => {
    const tick = setInterval(() => setTicks((ticks) => ticks + 1), TICK_MS);
    return () => clearInterval(tick);
  }, []);
  const now = Date.now();

  if (until === null) {
    return (
      <ChipTrigger tone="accent" aria-label={`${subject} unlocked. Lock`} onClick={onLock}>
        Unlocked
      </ChipTrigger>
    );
  }
  if (until <= now) {
    return (
      <ChipTrigger
        aria-label={`${subject} locked. Unlock`}
        onClick={() => void requestCredential()}
      >
        Locked
      </ChipTrigger>
    );
  }
  const minutes = Math.max(1, Math.ceil((until - now) / 60_000));
  return (
    <ChipTrigger
      tone="accent"
      aria-label={`${subject} unlocked for ${minutes} more min. Lock`}
      onClick={onLock}
    >
      Unlocked · {minutes} min
    </ChipTrigger>
  );
}
