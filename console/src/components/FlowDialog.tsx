import type { ComponentChildren } from 'preact';
import type { Transact } from '../lib/hooks';
import { Button, type ButtonKind } from './Button';
import { DialogSheet } from './DialogSheet';
import { TransactButton } from './Transact';

/** One footer action of a flow step. */
export interface FlowAction {
  label: string;
  onClick: () => void;
  kind?: ButtonKind;
  disabled?: boolean;
  /** Renders with the transaction's busy spinner when given. */
  transact?: Transact;
}

/**
 * One step of a guided flow: what it shows and what it offers next.
 * Definitions are rebuilt every render, so labels, guards, and step
 * visibility are plain expressions over live state.
 */
export interface FlowStep {
  id: string;
  body: ComponentChildren;
  /** The step's main action; omit for waiting or terminal bodies. */
  primary?: FlowAction;
  /** Actions placed before the primary, such as Back. */
  secondary?: FlowAction[];
}

/**
 * The one renderer for guided flows. A flow is data — an ordered step list —
 * so every guide shares the same sheet, step dots, footer layout, and escape
 * hatch: the dismiss action is always present and never mutates anything.
 */
export function FlowDialog({
  label,
  steps,
  current,
  onDismiss,
  dismissLabel = 'Cancel',
}: {
  label: string;
  steps: FlowStep[];
  current: string;
  onDismiss: () => void;
  dismissLabel?: string;
}) {
  const step = steps.find(({ id }) => id === current) ?? steps[0];
  return (
    <DialogSheet
      label={label}
      steps={steps.map(({ id }) => id)}
      currentStep={step.id}
      onDismiss={onDismiss}
      footer={
        <>
          <Button onClick={onDismiss}>{dismissLabel}</Button>
          <div class="sheetfoot-row">
            {step.secondary?.map((action) => (
              <FlowButton key={action.label} action={action} fallbackKind="secondary" />
            ))}
            {step.primary && <FlowButton action={step.primary} fallbackKind="primary" />}
          </div>
        </>
      }
    >
      {step.body}
    </DialogSheet>
  );
}

function FlowButton({ action, fallbackKind }: { action: FlowAction; fallbackKind: ButtonKind }) {
  const kind = action.kind ?? fallbackKind;
  return action.transact ? (
    <TransactButton
      transact={action.transact}
      kind={kind}
      disabled={action.disabled}
      onClick={action.onClick}
    >
      {action.label}
    </TransactButton>
  ) : (
    <Button kind={kind} disabled={action.disabled} onClick={action.onClick}>
      {action.label}
    </Button>
  );
}
