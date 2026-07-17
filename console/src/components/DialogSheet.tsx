import type { ComponentChildren, TargetedEvent } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

interface DialogSheetProps {
  label: string;
  steps: readonly string[];
  currentStep: string;
  children: ComponentChildren;
  footer: ComponentChildren;
  onDismiss: () => void;
}

/**
 * The modal sheet behind every guided flow. A native `<dialog>` shown with
 * `showModal()` owns the hard parts as platform behavior: focus is trapped in
 * the sheet, the background becomes inert, Escape raises `cancel`, and closing
 * returns focus to the opener.
 */
export function DialogSheet({
  label,
  steps,
  currentStep,
  children,
  footer,
  onDismiss,
}: DialogSheetProps) {
  const stepIndex = steps.indexOf(currentStep);
  const sheet = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = sheet.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  function dismissOnCancel(event: TargetedEvent<HTMLDialogElement>) {
    // The dialog stays mounted until the flow's own state unmounts it.
    event.preventDefault();
    onDismiss();
  }

  return (
    <dialog ref={sheet} class="sheet" aria-label={label} onCancel={dismissOnCancel}>
      <div class="stepline">
        {label}
        <span class="sr-only">
          Step {stepIndex + 1} of {steps.length}
        </span>
        <span class="stepdots" aria-hidden="true">
          {steps.map((name, index) => (
            <i key={name} class={index <= stepIndex ? 'on' : ''} />
          ))}
        </span>
      </div>
      <div class="sheetcontent" key={currentStep}>
        {children}
      </div>
      <div class="sheetfoot">{footer}</div>
    </dialog>
  );
}
