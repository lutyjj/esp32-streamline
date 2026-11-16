import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LinenProvider, ToastProvider } from 'linen';
import { afterEach, describe, expect, it } from 'vitest';
import { forgetAdminKey, unlockSettings } from '../../src/device/lib/adminKey';
import { setTransport } from '../../src/device/lib/http';
import { MOCK_ADMIN_KEY } from '../../src/device/mocks/device';
import { deviceConfig, deviceStatus, transportStatus } from '../../src/device/mocks/fixtures';
import { queryClient, settingsQuery } from '../../src/device/state/queries';
import { EncryptionScreen } from '../../src/device/ui/bridge/EncryptionScreen';
import type { TransportStatus } from '../../src/generated/api';
import { answering } from './answering';

// Every key state the device can hold leaves a way forward on the screen
// (docs/user-journey.md, stage 5).

function mount(transport: Partial<TransportStatus>) {
  const settings = deviceConfig({ transport: transportStatus(transport) });
  answering(deviceStatus());
  queryClient.setQueryData(settingsQuery.queryKey, settings);
  render(
    <LinenProvider>
      <ToastProvider>
        <EncryptionScreen />
      </ToastProvider>
    </LinenProvider>,
  );
}

afterEach(() => {
  cleanup();
  queryClient.clear();
  answering(null);
  forgetAdminKey();
  setTransport((request) => fetch(request));
});

describe('the encryption screen', () => {
  it('in the clear with a previous credential, holds a new one and offers to retire it', () => {
    mount({ active_key_id: 'eli1-new', rollback_key_id: 'eli1-old' });
    expect(screen.getByRole('button', { name: 'Make a credential' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Retire' })).toHaveProperty('disabled', false);
  });

  it('says a replacement the device left unanswered may have been made', async () => {
    unlockSettings(MOCK_ADMIN_KEY, false);
    // Writes drop; the settings read behind the failure finds them unchanged.
    setTransport(async (request) => {
      if (request.method === 'POST') throw new TypeError('Failed to fetch');
      return Response.json(queryClient.getQueryData(settingsQuery.queryKey));
    });
    mount({ mode: 'tls-psk', active_key_id: 'eli1-new' });
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    expect(await screen.findByText('The device did not answer.')).toBeDefined();
  });
});
