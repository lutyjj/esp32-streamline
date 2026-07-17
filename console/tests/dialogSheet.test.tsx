import { render } from 'preact';
import { act } from 'preact/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { DialogSheet } from '../src/components/DialogSheet';

function mount(onDismiss = vi.fn()) {
  const host = document.createElement('div');
  document.body.append(host);
  // act flushes the mount effect that calls showModal().
  act(() => {
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
  });
  return { host, onDismiss };
}

describe('DialogSheet', () => {
  it('owns the shared modal and step semantics as a native dialog', () => {
    const { host } = mount();
    // showModal() carries the modal contract natively: focus trap, inert
    // background, and the implicit dialog role.
    const dialog = host.querySelector('dialog');
    expect(dialog?.open).toBe(true);
    expect(dialog?.getAttribute('aria-label')).toBe('Level calibration');
    expect(host.querySelector('.sr-only')?.textContent).toContain('Step 2 of 3');
    host.remove();
  });

  it('routes the platform cancel path (Escape) to the flow dismissal', () => {
    const { host, onDismiss } = mount();
    const cancel = new Event('cancel', { cancelable: true });
    host.querySelector('dialog')?.dispatchEvent(cancel);
    expect(onDismiss).toHaveBeenCalledOnce();
    // The component keeps the dialog mounted; its flow state unmounts it.
    expect(cancel.defaultPrevented).toBe(true);
    host.remove();
  });
});
