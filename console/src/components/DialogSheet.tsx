import type { ComponentChildren, TargetedKeyboardEvent } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

interface DialogSheetProps {
  label: string;
  steps: readonly string[];
  currentStep: string;
  children: ComponentChildren;
  footer: ComponentChildren;
  onDismiss: () => void;
}

export function DialogSheet({
  label,
  steps,
  currentStep,
  children,
  footer,
  onDismiss,
}: DialogSheetProps) {
  const stepIndex = steps.indexOf(currentStep);
  const sheet = useRef<HTMLDivElement>(null);

  useEffect(() => sheet.current?.focus(), []);

  function dismissOnEscape(event: TargetedKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    onDismiss();
  }

  return (
    <div class="overlay">
      <div
        ref={sheet}
        class="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={dismissOnEscape}
      >
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
      </div>
    </div>
  );
}
