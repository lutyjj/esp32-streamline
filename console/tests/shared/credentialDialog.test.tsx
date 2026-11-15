import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LinenProvider } from 'linen';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialDialog } from '../../src/shared/CredentialDialog';
import {
  answerCredential,
  credentialAsked,
  requestCredential,
} from '../../src/shared/credentialGate';

// linen's dialog on Preact, as the consoles render it: a write that finds the
// console locked asks here, and the answer goes back to every write that asked.

const verify = vi.fn(async (secret: string) => (secret === 'right' ? 'accepted' : 'rejected'));

function mount() {
  render(
    <LinenProvider>
      <CredentialDialog
        title="Unlock settings"
        description="Use the key."
        label="Key"
        remember="Remember on this browser"
        rejected="That key was refused."
        verify={verify}
      />
    </LinenProvider>,
  );
}

afterEach(() => {
  if (credentialAsked.value) answerCredential(false);
  cleanup();
});

/** Ask as a locked write does; the answer stays wrapped so awaiting the dialog does not await it. */
async function ask(): Promise<{ answer: Promise<boolean> }> {
  let answer!: Promise<boolean>;
  act(() => {
    answer = requestCredential();
  });
  await screen.findByRole('dialog', { name: 'Unlock settings' });
  return { answer };
}

function type(value: string) {
  fireEvent.input(screen.getByLabelText('Key'), { target: { value } });
}

describe('the credential dialog', () => {
  it('keeps a refusal beside the field, then lets the write go on', async () => {
    mount();
    const { answer } = await ask();
    type('wrong');
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect((await screen.findByRole('alert')).textContent).toBe('That key was refused.');

    type('right');
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await expect(answer).resolves.toBe(true);
    expect(verify).toHaveBeenLastCalledWith('right', false);
  });

  it('hands the remember choice to the check', async () => {
    mount();
    const { answer } = await ask();
    type('right');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Remember on this browser' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await expect(answer).resolves.toBe(true);
    expect(verify).toHaveBeenLastCalledWith('right', true);
  });

  it('declines for every waiting write when cancelled, and starts empty next time', async () => {
    mount();
    const { answer } = await ask();
    type('half typed');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(answer).resolves.toBe(false);

    await ask();
    await waitFor(() => expect((screen.getByLabelText('Key') as HTMLInputElement).value).toBe(''));
  });
});
