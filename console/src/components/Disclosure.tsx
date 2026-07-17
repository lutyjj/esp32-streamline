import type { ComponentChildren, TargetedTransitionEvent } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';

const PANEL_MS = 180;

interface DisclosureProps {
  title: string;
  children: ComponentChildren;
  className?: string;
  defaultOpen?: boolean;
  /**
   * Controlled mode: the parent owns the open state, so another control (a
   * checkbox, a journey event) can expand the section. Omit for the default
   * self-managed behavior.
   */
  open?: boolean;
  onToggle?: (open: boolean) => void;
}

export function Disclosure({
  title,
  children,
  className = '',
  defaultOpen = false,
  open: controlledOpen,
  onToggle,
}: DisclosureProps) {
  const controlled = controlledOpen !== undefined;
  const panelId = useId();
  const [open, setOpen] = useState(controlled ? controlledOpen : defaultOpen);
  const [present, setPresent] = useState(open);
  // The panel clips overflow only while its size animates; once opening
  // settles, overflow is freed so intrinsic-height content is never clipped.
  // Mounting open paints at rest with no transition, so it starts settled.
  const [settled, setSettled] = useState(open);
  const openFrame = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const settleTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (openFrame.current !== null) window.cancelAnimationFrame(openFrame.current);
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    },
    [],
  );

  function clearCloseTimer() {
    if (closeTimer.current === null) return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }

  function clearSettleTimer() {
    if (settleTimer.current === null) return;
    window.clearTimeout(settleTimer.current);
    settleTimer.current = null;
  }

  function openDisclosure() {
    clearCloseTimer();
    setPresent(true);
    openFrame.current = window.requestAnimationFrame(() => {
      // Mount closed for one paint so the opening transition has a start value.
      openFrame.current = window.requestAnimationFrame(() => {
        openFrame.current = null;
        setOpen(true);
      });
    });
    // Reduced-motion mode fires no transitionend; the timer settles instead.
    clearSettleTimer();
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      setSettled(true);
    }, PANEL_MS);
  }

  function closeDisclosure() {
    if (openFrame.current !== null) {
      window.cancelAnimationFrame(openFrame.current);
      openFrame.current = null;
    }
    clearSettleTimer();
    setSettled(false);
    setOpen(false);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setPresent(false);
    }, PANEL_MS);
  }

  // Follow the parent's state through the same animation as a click.
  const applied = useRef(open);
  useEffect(() => {
    if (!controlled || controlledOpen === applied.current) return;
    applied.current = controlledOpen;
    if (controlledOpen) openDisclosure();
    else closeDisclosure();
  });

  function toggle() {
    // The parent's value is the truth in controlled mode; the internal state
    // only tracks the animation phase and lags it by a frame.
    const next = controlled ? !controlledOpen : !open;
    onToggle?.(next);
    if (controlled) return;
    if (next) openDisclosure();
    else closeDisclosure();
  }

  function onPanelTransitionEnd(event: TargetedTransitionEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    if (open) {
      clearSettleTimer();
      setSettled(true);
      return;
    }
    clearCloseTimer();
    setPresent(false);
  }

  return (
    <div
      class={`disclosure${open ? ' open' : ''}${settled ? ' settled' : ''}${className ? ` ${className}` : ''}`}
    >
      <button
        class="disclosure-summary"
        type="button"
        aria-expanded={open}
        aria-controls={present ? panelId : undefined}
        onClick={toggle}
      >
        {title}
      </button>
      {present && (
        <div class="disclosure-panel" id={panelId} onTransitionEnd={onPanelTransitionEnd}>
          <div class="disclosure-body">{children}</div>
        </div>
      )}
    </div>
  );
}
