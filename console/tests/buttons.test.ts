import { describe, expect, it } from 'vitest';
import type { ButtonActionStatus, ButtonCapabilityStatus } from '../src/lib/api';
import { BUTTON_ACTION_CHOICES, buttonRows, DESTRUCTIVE_ACTIONS } from '../src/lib/buttons';

const button = (
  id: string,
  extra: Partial<ButtonCapabilityStatus> = {},
): ButtonCapabilityStatus => ({
  id,
  label: id.toUpperCase(),
  gpio: 36,
  active_low: true,
  default_action: 'none',
  ...extra,
});

describe('buttonRows', () => {
  it('zips each board button with its effective action in descriptor order', () => {
    const buttons = [
      button('key1', { label: 'Key 1', default_action: 'toggle_stream' }),
      button('key2'),
    ];
    const actions: ButtonActionStatus[] = [
      { id: 'key1', action: 'restart' },
      { id: 'key2', action: 'cycle_input' },
    ];
    expect(buttonRows(buttons, actions)).toEqual([
      { id: 'key1', label: 'Key 1', action: 'restart' },
      { id: 'key2', label: 'KEY2', action: 'cycle_input' },
    ]);
  });

  it('falls back to the descriptor default when settings omit the button', () => {
    const buttons = [button('key1', { default_action: 'toggle_stream' })];
    expect(buttonRows(buttons, [])).toEqual([
      { id: 'key1', label: 'KEY1', action: 'toggle_stream' },
    ]);
  });

  it('offers every assignable action, and only factory reset is destructive', () => {
    expect(BUTTON_ACTION_CHOICES.map((choice) => choice.value)).toEqual([
      'none',
      'toggle_stream',
      'cycle_input',
      'gain_up',
      'gain_down',
      'attenuation_up',
      'attenuation_down',
      'restart',
      'factory_reset',
    ]);
    expect([...DESTRUCTIVE_ACTIONS]).toEqual(['factory_reset']);
  });
});
