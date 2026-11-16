import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LinenProvider, ToastProvider, UnsavedChangesGuard } from 'linen';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deviceConfig, deviceStatus } from '../../src/device/mocks/fixtures';
import { UPDATE_BUSY_REASON } from '../../src/device/state/ota';
import { audioProfilesQuery, settingsQuery } from '../../src/device/state/queries';
import { AudioScreen } from '../../src/device/ui/audio/AudioScreen';
import { BridgeScreen } from '../../src/device/ui/bridge/BridgeScreen';
import { DeviceScreen } from '../../src/device/ui/device/DeviceScreen';
import { replacePath } from '../../src/shared/navigation';
import { queryClient } from '../../src/shared/queries';
import { PeerContext } from '../../src/shared/writeFailure';
import { answering } from './answering';

// An action that can restart the device waits while a firmware update runs,
// and says so beside it (docs/user-journey.md, shared promises).

function mount(path: string, page = <AudioScreen />) {
  replacePath(path);
  render(
    <LinenProvider>
      <PeerContext.Provider value="device">
        <ToastProvider>
          <UnsavedChangesGuard>{page}</UnsavedChangesGuard>
        </ToastProvider>
      </PeerContext.Provider>
    </LinenProvider>,
  );
}

describe('during a firmware update', () => {
  beforeEach(() => {
    queryClient.setQueryData(audioProfilesQuery.queryKey, {
      schema_version: 1,
      board_id: deviceStatus().capabilities.board_id,
      active_profile_id: null,
      profiles: [
        {
          id: 'loud',
          name: 'Loud',
          audio: { input_line: 2, input_gain: 0, adc_attenuation_db: 18 },
        },
      ],
    });
    queryClient.setQueryData(settingsQuery.queryKey, deviceConfig());
    answering(deviceStatus({ ota: { busy: true, phase: 'checking' } }));
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
    answering(null);
    replacePath('/');
  });

  it('holds the profile picker and says why', () => {
    mount('/audio');
    expect(screen.getByRole('combobox', { name: 'Profile' })).toHaveProperty('disabled', true);
    expect(screen.getByText(UPDATE_BUSY_REASON)).toBeDefined();
  });

  it('holds the levels save and says why', () => {
    mount('/audio/levels');
    fireEvent.input(screen.getByLabelText('Gain'), { target: { value: '12' } });
    expect(screen.getByRole('button', { name: 'Discard changes' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
    expect(screen.getByText(UPDATE_BUSY_REASON)).toBeDefined();
  });

  it('holds Join on another network and says why', () => {
    mount('/device/wifi', <DeviceScreen />);
    fireEvent.input(screen.getByLabelText('Network name'), { target: { value: 'Cafe guest' } });
    expect(screen.getByRole('button', { name: 'Join network' })).toHaveProperty('disabled', true);
    expect(screen.getByText(UPDATE_BUSY_REASON)).toBeDefined();
  });

  it('holds saving a new bridge and says why', () => {
    mount('/bridge/target', <BridgeScreen />);
    fireEvent.input(screen.getByLabelText('Bridge address'), { target: { value: '192.0.2.21' } });
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
    expect(screen.getByText(UPDATE_BUSY_REASON)).toBeDefined();
  });
});
