import type { ComponentChildren } from 'preact';
import type { ActionState as ActionStateValue, Transact } from '../lib/hooks';
import { Button, type ButtonKind } from './Button';

/**
 * Rendering for the useTransact lifecycle: the button that carries the busy
 * spinner and the per-card result line shown next to it.
 */

interface TransactButtonProps {
  transact: Transact;
  children: ComponentChildren;
  kind?: ButtonKind;
  type?: 'submit' | 'button';
  /** Gates beyond the transaction itself, e.g. locked settings. */
  disabled?: boolean;
  onClick?: () => void;
}

export function TransactButton({
  transact,
  children,
  kind = 'primary',
  type = 'button',
  disabled = false,
  onClick,
}: TransactButtonProps) {
  return (
    <Button kind={kind} type={type} disabled={disabled} busy={transact.busy} onClick={onClick}>
      {children}
    </Button>
  );
}

export function ActionState({ state }: { state: ActionStateValue }) {
  return <span class={`actionstate ${state.cls}`}>{state.text}</span>;
}
