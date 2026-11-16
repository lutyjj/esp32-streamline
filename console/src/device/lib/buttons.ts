import type { ButtonAction, ButtonActionStatus, ButtonCapabilityStatus } from '../../generated/api';

export interface ButtonRow {
  id: string;
  label: string;
  action: ButtonAction;
}

/**
 * Pair each board button with its effective action, in descriptor order.
 * Labels come from the status and actions from the settings, which a board
 * change can leave a read apart, so a button the settings do not name yet
 * shows its descriptor default.
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

/** What each action is called and what a press does, in the order the console offers them. */
export const BUTTON_ACTIONS: Record<ButtonAction, { label: string; summary: string }> = {
  none: { label: 'Do nothing', summary: 'A press does nothing.' },
  toggle_stream: {
    label: 'Pause or resume streaming',
    summary: 'A press pauses or resumes streaming to the bridge.',
  },
  cycle_input: { label: 'Next input', summary: 'A press selects the next input line.' },
  gain_up: { label: 'Gain up', summary: 'A press raises the input gain one step.' },
  gain_down: { label: 'Gain down', summary: 'A press lowers the input gain one step.' },
  attenuation_up: {
    label: 'Attenuation up',
    summary: 'A press attenuates the input one step more, which is quieter.',
  },
  attenuation_down: {
    label: 'Attenuation down',
    summary: 'A press attenuates the input one step less, which is louder.',
  },
  restart: { label: 'Restart', summary: 'A press restarts the device, settings intact.' },
  factory_reset: {
    label: 'Factory reset',
    summary: 'One press erases every setting and returns the device to setup.',
  },
};

/** The action a press cannot take back, so assigning it asks first. */
export const DESTRUCTIVE_ACTION: ButtonAction = 'factory_reset';
