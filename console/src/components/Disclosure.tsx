import type { ComponentChildren, TargetedTransitionEvent } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

const CLOSE_MS = 180;

interface DisclosureProps {
  title: string;
  children: ComponentChildren;
  className?: string;
  defaultOpen?: boolean;
}

export function Disclosure({
  title,
  children,
  className = '',
  defaultOpen = false,
}: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [present, setPresent] = useState(defaultOpen);
  const openFrame = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (openFrame.current !== null) window.cancelAnimationFrame(openFrame.current);
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  function clearCloseTimer() {
    if (closeTimer.current === null) return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
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
  }

  function closeDisclosure() {
    if (openFrame.current !== null) {
      window.cancelAnimationFrame(openFrame.current);
      openFrame.current = null;
    }
    setOpen(false);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setPresent(false);
    }, CLOSE_MS);
  }

  function toggle() {
    if (open) closeDisclosure();
    else openDisclosure();
  }

  function finishClose(event: TargetedTransitionEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget || open) return;
    clearCloseTimer();
    setPresent(false);
  }

  return (
    <div class={`disclosure${open ? ' open' : ''}${className ? ` ${className}` : ''}`}>
      <button class="disclosure-summary" type="button" aria-expanded={open} onClick={toggle}>
        {title}
      </button>
      {present && (
        <div class="disclosure-panel" onTransitionEnd={finishClose}>
          <div class="disclosure-body">{children}</div>
        </div>
      )}
    </div>
  );
}
