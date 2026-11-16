import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LinenProvider } from 'linen';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WriteConfirm } from '../../src/device/ui/WriteConfirm';
import { ApiError } from '../../src/shared/http';

// A confirmed device write: the dialog waits for the answer, closes once the
// write is done or the unlock declined, and keeps a failure in view.

function mount(write: () => Promise<unknown>) {
  const onOpenChange = vi.fn();
  render(
    <LinenProvider>
      <WriteConfirm
        open
        onOpenChange={onOpenChange}
        title="Restart the device?"
        description="Audio stops while it restarts."
        confirmLabel="Restart"
        failed="The device did not restart."
        write={write}
      />
    </LinenProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
  return onOpenChange;
}

afterEach(cleanup);

describe('a confirmed write', () => {
  it('closes once the write is done, or the unlock declined', async () => {
    const onOpenChange = mount(async () => null);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('stays open with a refusal, which did not happen', async () => {
    const onOpenChange = mount(async () => {
      throw new ApiError(409, 'an update is running');
    });
    expect(await screen.findByText('The device did not restart.')).toBeDefined();
    expect(screen.getByText('an update is running')).toBeDefined();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('says a write left unanswered may have happened, rather than that it did not', async () => {
    mount(async () => {
      throw new Error('the device did not answer in time');
    });
    expect(await screen.findByText('The device did not answer.')).toBeDefined();
    expect(screen.queryByText('The device did not restart.')).toBeNull();
  });
});
