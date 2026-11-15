import { afterEach, describe, expect, it } from 'vitest';
import { deviceContract, deviceStatus } from '../../src/device/mocks/fixtures';
import { contract } from '../../src/device/state/device';
import { UPDATE_BUSY_REASON, updateLock } from '../../src/device/state/ota';
import { answering } from './answering';

afterEach(() => {
  contract.value = null;
  answering(null);
});

/** Every write the contract declares, with its `x-restarting` mark. */
function writes(): [string, boolean][] {
  return Object.entries(deviceContract().paths ?? {}).flatMap(([path, operations]) =>
    operations.post ? [[path, operations.post['x-restarting'] === true] as [string, boolean]] : [],
  );
}

describe('update lock', () => {
  it('withholds exactly the writes the contract marks x-restarting while an update is busy', () => {
    contract.value = deviceContract();
    answering(deviceStatus({ ota: { busy: true, phase: 'checking' } }));

    expect(writes().filter(([, restarting]) => restarting).length).toBeGreaterThan(0);
    for (const [path, restarting] of writes()) {
      expect(updateLock(path), path).toBe(restarting ? UPDATE_BUSY_REASON : null);
    }
  });

  it('withholds nothing while no update runs', () => {
    contract.value = deviceContract();
    answering(deviceStatus({ ota: { busy: false, phase: 'idle' } }));

    for (const [path] of writes()) expect(updateLock(path), path).toBeNull();
  });

  it('leaves the refusal to the device until its contract loads', () => {
    answering(deviceStatus({ ota: { busy: true, phase: 'checking' } }));

    for (const [path] of writes()) expect(updateLock(path), path).toBeNull();
  });
});
