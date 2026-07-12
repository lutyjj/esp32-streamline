import { render } from 'preact';
import { describe, expect, it, vi } from 'vitest';
import { DialogSheet } from '../src/components/DialogSheet';

function mount(onDismiss = vi.fn()) {
  const host = document.createElement('div');
  document.body.append(host);
  render(
    <DialogSheet
      label="Level calibration"
      steps={['prepare', 'measure', 'done']}
      currentStep="measure"
      onDismiss={onDismiss}
      footer={<button type="button">Cancel</button>}
    >
      <p>Measure the source</p>
    </DialogSheet>,
    host,
  );
  return { host, onDismiss };
}

describe('DialogSheet', () => {
  it('owns the shared modal and step semantics', () => {
    const { host } = mount();
    const dialog = host.querySelector<HTMLElement>('[role=dialog]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-label')).toBe('Level calibration');
    expect(host.querySelector('.sr-only')?.textContent).toContain('Step 2 of 3');
    host.remove();
  });

  it('dismisses consistently with Escape', () => {
    const { host, onDismiss } = mount();
    host
      .querySelector('[role=dialog]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onDismiss).toHaveBeenCalledOnce();
    host.remove();
  });
});
