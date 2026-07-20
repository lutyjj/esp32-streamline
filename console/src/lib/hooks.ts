import { useEffect, useRef, useState } from 'preact/hooks';
import { status } from '../state/device';
import { beginRebootWait } from '../state/rebootWait';
import { isUnlocked, useAuthEpoch } from './adminKey';
import type { Ack } from './api';
import { errorMessage } from './errors';

/** True when the device accepts settings writes from this browser right now. */
export function useWritable(): boolean {
  useAuthEpoch();
  const s = status.value;
  if (!s) return false;
  if (s.configuration_writable === false) return false;
  return !s.auth_required || isUnlocked();
}

/** A form field bound to a value the device also reports live. */
export interface DeviceField {
  /** Current content, ready to bind to an input's `value`. */
  value: string;
  /** True while the content differs from the device's applied value. */
  dirty: boolean;
  /** Bumps each time the device moved the field while it was clean; key a cue
   *  on it to replay a "changed under you" animation. */
  revision: number;
  /** Take a keystroke. */
  set(next: string): void;
  /** Accept the current value as applied, after a save the device confirms. */
  commit(): void;
}

/**
 * Bind a form field to a value the device also reports live in `/api/status`.
 *
 * The field follows the device as long as the user has not typed over it — so a
 * board button, another API client, or a companion tab that changes the value
 * shows up here within one poll, without a reload. Once edited, the field holds
 * the user's value and reads `dirty` until they save (`commit`); a device change
 * underneath a dirty field is never stomped, it just re-baselines so `dirty`
 * keeps meaning "differs from what the device holds".
 *
 * This is the shared cure for a control seeded once from the settings snapshot
 * going stale — reach for it wherever a form mirrors live device state. `live`
 * is `null` until the first status arrives, so nothing flashes on load.
 */
export function useDeviceField(live: string | null): DeviceField {
  const [value, setValueState] = useState(live ?? '');
  const [baseline, setBaseline] = useState(live ?? '');
  const [revision, setRevision] = useState(0);
  // The last live value the follow effect reconciled against. A ref, not state,
  // so committing (which re-baselines without a device change) cannot retrigger
  // the effect and revert the field.
  const seen = useRef<string | null>(live);
  const valueRef = useRef(value);
  // Mirror every write into a ref so the follow effect reads the latest value
  // without listing `value` as a dependency (which would re-run it on load).
  const set = (next: string) => {
    valueRef.current = next;
    setValueState(next);
  };

  useEffect(() => {
    if (live === null) return; // device value not known yet
    const prev = seen.current;
    seen.current = live;
    if (prev === null) {
      // First real value: seed the field silently, no cue.
      valueRef.current = live;
      setValueState(live);
      setBaseline(live);
      return;
    }
    if (prev === live) return; // device held steady
    setBaseline(live); // "unsaved" now measures against the new device value
    if (valueRef.current === prev) {
      // Field untouched → follow the device and cue the move.
      valueRef.current = live;
      setValueState(live);
      setRevision((r) => r + 1);
    }
  }, [live]);

  return {
    value,
    dirty: value !== baseline,
    revision,
    set,
    commit: () => {
      seen.current = valueRef.current;
      setBaseline(valueRef.current);
    },
  };
}

export interface ActionState {
  text: string;
  cls: '' | 'ok' | 'err';
}

export interface Transact {
  busy: boolean;
  state: ActionState;
  setState(next: ActionState): void;
  run(work: () => Promise<Ack | undefined>, opts?: TransactOpts): Promise<void>;
}

export interface TransactOpts {
  busyText?: string;
  okText?: string;
  /** Label for the restart narration when the device answers `rebooting`. */
  reboots?: string;
}

/** How long a success confirmation holds before it clears itself. */
const SUCCESS_HOLD_MS = 2600;

/**
 * One visible lifecycle for every mutation: busy button → a brief confirmation
 * that clears itself → for rebooting actions the expected-offline narration.
 */
export function useTransact(): Transact {
  const [busy, setBusy] = useState(false);
  // State updates do not synchronously re-render the button. Keep the guard in
  // a ref as well so two clicks in the same render cannot start two writes.
  const running = useRef(false);
  const clearTimer = useRef<ReturnType<typeof setTimeout>>();
  const [state, setState] = useState<ActionState>({ text: '', cls: '' });

  async function run(work: () => Promise<Ack | undefined>, opts: TransactOpts = {}): Promise<void> {
    if (running.current) return;
    running.current = true;
    clearTimeout(clearTimer.current);
    setBusy(true);
    setState({ text: opts.busyText ?? 'Working…', cls: '' });
    try {
      const data = await work();
      if (opts.reboots && data && (data as Ack).rebooting) {
        setState({ text: 'Saved — device is restarting', cls: 'ok' });
        beginRebootWait(opts.reboots);
      } else {
        setState({ text: opts.okText ?? 'Saved', cls: 'ok' });
      }
      // A write that lands confirms for a beat, then clears itself, so the
      // result reads as a moment the device answered, not a label that stays.
      clearTimer.current = setTimeout(() => setState({ text: '', cls: '' }), SUCCESS_HOLD_MS);
    } catch (error) {
      setState({ text: errorMessage(error), cls: 'err' });
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return { busy, state, setState, run };
}
