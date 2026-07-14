import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { Button } from './Button';

interface ConfirmButtonProps {
  /** The idle trigger button content. */
  label: ComponentChildren;
  /** The armed confirmation button content. */
  confirmLabel: ComponentChildren;
  onConfirm: () => void;
  /**
   * When set, the confirmation is a bordered box carrying this warning — for a
   * prominent action. Omit it for a compact list row, where the trigger simply
   * swaps for confirm/cancel in place.
   */
  message?: ComponentChildren;
  disabled?: boolean;
}

/**
 * In-console confirmation for a destructive action, in place of a native
 * `window.confirm` dialog. One click arms it, a second confirms, and Cancel is
 * always the way out — the journey's "no state without an exit".
 */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  message,
  disabled = false,
}: ConfirmButtonProps) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <Button kind="danger" disabled={disabled} onClick={() => setConfirming(true)}>
        {label}
      </Button>
    );
  }

  function confirm() {
    onConfirm();
    setConfirming(false);
  }

  const controls = (
    <>
      <Button kind="danger" disabled={disabled} onClick={confirm}>
        {confirmLabel}
      </Button>
      <Button onClick={() => setConfirming(false)}>Cancel</Button>
    </>
  );

  // One container, so the armed pair stays where the trigger stood instead of
  // scattering as separate items of the parent's flex layout.
  if (!message) return <span class="confirm-inline">{controls}</span>;

  return (
    <div class="confirmbox">
      <span>{message}</span>
      <div class="row">{controls}</div>
    </div>
  );
}
