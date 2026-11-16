import { cleanup, render, screen } from '@testing-library/react';
import { LinenProvider } from 'linen';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { NewRecording } from '../../src/bridge/ui/recordings/NewRecording';
import type { BridgeStatus } from '../../src/generated/bridge';
import { PeerContext } from '../../src/shared/writeFailure';
import { bridgeStatus, SOURCE } from './fixtures';

const OTHER = '192.0.2.11';

afterEach(cleanup);

/** A bridge that knows `ids`, each streaming as the contract's example source does. */
function knowing(...ids: string[]): BridgeStatus {
  const status = bridgeStatus();
  const example = status.sources[SOURCE];
  status.sources = Object.fromEntries(ids.map((id) => [id, example]));
  return status as BridgeStatus;
}

function form(known: BridgeStatus): ReactNode {
  return (
    <LinenProvider>
      <PeerContext.Provider value="bridge">
        <NewRecording known={known} busy={[]} limit={80} room={3600} onStarted={() => {}} />
      </PeerContext.Provider>
    </LinenProvider>
  );
}

describe('a new recording', () => {
  it('holds the source it shows first, and never records another in its place', async () => {
    const { rerender } = render(form(knowing(SOURCE, OTHER)));
    expect(await screen.findByText(SOURCE)).toBeDefined();

    rerender(form(knowing(OTHER)));

    expect(
      await screen.findByText('This source is no longer available to record. Choose another.'),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Start recording' }).hasAttribute('disabled')).toBe(
      true,
    );
  });
});
