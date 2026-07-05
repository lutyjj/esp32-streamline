import type { ComponentChildren } from 'preact';
import type { ActionState as ActionStateValue, Transact } from '../lib/hooks';

/**
 * Rendering for the useTransact lifecycle: the button that carries the busy
 * spinner and the per-card result line shown next to it.
 */

interface TransactButtonProps {
  transact: Transact;
  children: ComponentChildren;
  kind?: 'primary' | 'secondary' | 'danger';
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
    <button
      class={`btn ${kind}${transact.busy ? ' busy' : ''}`}
      type={type}
      disabled={disabled || transact.busy}
      onClick={onClick}
    >
      <span class="spin" />
      {children}
    </button>
  );
}

export function ActionState({ state }: { state: ActionStateValue }) {
  return <span class={`actionstate ${state.cls}`}>{state.text}</span>;
}
