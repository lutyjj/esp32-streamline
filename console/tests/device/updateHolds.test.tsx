import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LinenProvider, ToastProvider, UnsavedChangesGuard } from 'linen';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deviceConfig, deviceContract, deviceStatus } from '../../src/device/mocks/fixtures';
import { audioProfiles, config, contract } from '../../src/device/state/device';
import { UPDATE_BUSY_REASON } from '../../src/device/state/ota';
import { AudioScreen } from '../../src/device/ui/audio/AudioScreen';
import { BridgeScreen } from '../../src/device/ui/bridge/BridgeScreen';
import { DeviceScreen } from '../../src/device/ui/device/DeviceScreen';
import { replacePath } from '../../src/shared/navigation';
import { answering } from './answering';

// An action that can restart the device waits while a firmware update runs,
// and says so beside it (docs/user-journey.md, shared promises).

function mount(path: string, page = <AudioScreen />) {
  replacePath(path);
  render(
    <LinenProvider>
      <ToastProvider>
        <UnsavedChangesGuard>{page}</UnsavedChangesGuard>
      </ToastProvider>
    </LinenProvider>,
  );
}

describe('during a firmware update', () => {
  beforeEach(() => {
    contract.value = deviceContract();
    audioProfiles.value = {
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
    };
    config.value = deviceConfig();
    answering(deviceStatus({ ota: { busy: true, phase: 'checking' } }));
  });

  afterEach(() => {
    cleanup();
    contract.value = null;
    audioProfiles.value = null;
    config.value = null;
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
