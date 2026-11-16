import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LinenProvider, ToastProvider, UnsavedChangesGuard } from 'linen';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deviceContract, deviceStatus } from '../../src/device/mocks/fixtures';
import { audioProfiles, contract } from '../../src/device/state/device';
import { UPDATE_BUSY_REASON } from '../../src/device/state/ota';
import { AudioScreen } from '../../src/device/ui/audio/AudioScreen';
import { replacePath } from '../../src/shared/navigation';
import { answering } from './answering';

// An action that can restart the device waits while a firmware update runs,
// and says so beside it (docs/user-journey.md, shared promises).

function mount(path: string) {
  replacePath(path);
  render(
    <LinenProvider>
      <ToastProvider>
        <UnsavedChangesGuard>
          <AudioScreen />
        </UnsavedChangesGuard>
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
    answering(deviceStatus({ ota: { busy: true, phase: 'checking' } }));
  });

  afterEach(() => {
    cleanup();
    contract.value = null;
    audioProfiles.value = null;
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
});
