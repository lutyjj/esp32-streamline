import { render } from 'preact';
import { act } from 'preact/test-utils';
import { describe, expect, it, vi } from 'vitest';

const { copyText, toast } = vi.hoisted(() => ({
  copyText: vi.fn(() => Promise.resolve()),
  toast: vi.fn(),
}));
vi.mock('../src/lib/custody', () => ({ copyText }));
vi.mock('../src/state/toasts', () => ({ toast }));

import { CopyButton } from '../src/components/CopyButton';

function mount(ui: Parameters<typeof render>[0]): HTMLElement {
  const host = document.createElement('div');
  render(ui, host);
  return host;
}

describe('CopyButton', () => {
  it('copies the value and toasts the success message', async () => {
    copyText.mockResolvedValueOnce(undefined);
    const host = mount(
      <CopyButton value="psk-123" copied="PSK copied">
        Copy PSK
      </CopyButton>,
    );
    const button = host.querySelector('button');
    expect(button?.textContent).toContain('Copy PSK');

    await act(async () => {
      button?.click();
    });

    expect(copyText).toHaveBeenCalledWith('psk-123');
    expect(toast).toHaveBeenCalledWith('PSK copied', 'ok');
  });

  it('toasts the clipboard error when the copy fails', async () => {
    copyText.mockRejectedValueOnce(new Error('clipboard blocked'));
    const host = mount(
      <CopyButton value="x" copied="Copied">
        Copy
      </CopyButton>,
    );

    await act(async () => {
      host.querySelector('button')?.click();
    });

    expect(toast).toHaveBeenCalledWith('clipboard blocked', 'err');
  });
});
