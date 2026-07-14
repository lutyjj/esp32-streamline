import { render } from 'preact';
import { beforeEach, describe, expect, it } from 'vitest';
import { InputWizard } from '../src/components/InputWizard';
import { status } from '../src/state/device';
import { deviceStatus } from './fixtures';

describe('InputWizard', () => {
  beforeEach(() => {
    status.value = deviceStatus({ auth_required: false });
  });

  it('announces the passthrough choice and adds its step on capable boards', () => {
    const host = document.createElement('div');
    render(<InputWizard onClose={() => {}} />, host);

    expect(host.textContent).toContain('Set up your input');
    expect(host.textContent).toContain('then offers the local analog output');
    expect(host.querySelectorAll('.stepdots i')).toHaveLength(5);
  });

  it('stays a pure level guide on boards without the route', () => {
    const s = deviceStatus({ auth_required: false });
    status.value = {
      ...s,
      capabilities: { ...s.capabilities, analog_passthrough: null },
    };
    const host = document.createElement('div');
    render(<InputWizard onClose={() => {}} />, host);

    expect(host.textContent).not.toContain('local analog output');
    expect(host.querySelectorAll('.stepdots i')).toHaveLength(4);
  });
});
