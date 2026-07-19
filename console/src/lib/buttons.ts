import type { ButtonAction, ButtonActionStatus, ButtonCapabilityStatus } from './api';

export interface ButtonRow {
  id: string;
  label: string;
  action: ButtonAction;
}

/**
 * Pair each board button with its effective action, in descriptor order. The
 * device returns an action for every button, so this normally just zips the
 * two lists; a missing entry falls back to the button's descriptor default so
 * a row never renders blank.
 */
export function buttonRows(
  buttons: ButtonCapabilityStatus[],
  actions: ButtonActionStatus[],
): ButtonRow[] {
  const actionById = new Map(actions.map((entry) => [entry.id, entry.action]));
  return buttons.map((button) => ({
    id: button.id,
    label: button.label,
    action: actionById.get(button.id) ?? button.default_action,
  }));
}

/** The assignable actions in display order, with the label the console shows. */
export const BUTTON_ACTION_CHOICES: { value: ButtonAction; label: string }[] = [
  { value: 'none', label: 'Do nothing' },
  { value: 'toggle_stream', label: 'Start/stop streaming' },
  { value: 'cycle_input', label: 'Switch input line' },
  { value: 'gain_up', label: 'Input gain up' },
  { value: 'gain_down', label: 'Input gain down' },
  { value: 'attenuation_up', label: 'Attenuation up' },
  { value: 'attenuation_down', label: 'Attenuation down' },
  { value: 'restart', label: 'Restart device' },
  { value: 'factory_reset', label: 'Factory reset' },
];

/** One-line description of what each action does, shown under the button name. */
export const BUTTON_ACTION_SUMMARY: Record<ButtonAction, string> = {
  none: 'A press does nothing',
  toggle_stream: 'Pauses or resumes streaming to the bridge',
  cycle_input: 'Selects the next input line',
  gain_up: 'Raises the input gain one step',
  gain_down: 'Lowers the input gain one step',
  attenuation_up: 'Attenuates the input one step — quieter',
  attenuation_down: 'Attenuates the input one step less — louder',
  restart: 'Reboots with settings intact',
  factory_reset: 'Erases every setting and returns to setup',
};

/** Actions whose one press cannot be undone, warned about in the row. */
export const DESTRUCTIVE_ACTIONS: ReadonlySet<ButtonAction> = new Set(['factory_reset']);
