import { useRef, useState } from 'preact/hooks';
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

/**
 * One visible lifecycle for every mutation: busy button → per-card result →
 * for rebooting actions the expected-offline narration.
 */
export function useTransact(): Transact {
  const [busy, setBusy] = useState(false);
  // State updates do not synchronously re-render the button. Keep the guard in
  // a ref as well so two clicks in the same render cannot start two writes.
  const running = useRef(false);
  const [state, setState] = useState<ActionState>({ text: '', cls: '' });

  async function run(work: () => Promise<Ack | undefined>, opts: TransactOpts = {}): Promise<void> {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setState({ text: opts.busyText || 'Working…', cls: '' });
    try {
      const data = await work();
      if (opts.reboots && data && (data as Ack).rebooting) {
        setState({ text: 'Saved — device is restarting', cls: 'ok' });
        beginRebootWait(opts.reboots);
      } else {
        setState({ text: opts.okText ?? 'Done', cls: 'ok' });
      }
    } catch (error) {
      setState({ text: errorMessage(error), cls: 'err' });
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return { busy, state, setState, run };
}
