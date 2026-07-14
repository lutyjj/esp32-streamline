import { describe, expect, it } from 'vitest';
import type { LedCapabilityStatus, LedRoleStatus } from '../src/lib/api';
import { LED_ROLE_CHOICES, ledRows } from '../src/lib/leds';

const led = (id: string, extra: Partial<LedCapabilityStatus> = {}): LedCapabilityStatus => ({
  id,
  label: id.toUpperCase(),
  gpio: 22,
  active_low: false,
  default_role: 'off',
  ...extra,
});

describe('ledRows', () => {
  it('zips each board LED with its effective role in descriptor order', () => {
    const leds = [led('status', { label: 'Status light', default_role: 'status' }), led('aux')];
    const roles: LedRoleStatus[] = [
      { id: 'status', role: 'off' },
      { id: 'aux', role: 'on' },
    ];
    expect(ledRows(leds, roles)).toEqual([
      { id: 'status', label: 'Status light', role: 'off' },
      { id: 'aux', label: 'AUX', role: 'on' },
    ]);
  });

  it('falls back to the descriptor default when settings omit the LED', () => {
    const leds = [led('status', { default_role: 'status' })];
    expect(ledRows(leds, [])).toEqual([{ id: 'status', label: 'STATUS', role: 'status' }]);
  });

  it('offers status, on, and off as the role choices', () => {
    expect(LED_ROLE_CHOICES.map((choice) => choice.value)).toEqual(['status', 'on', 'off']);
  });
});
