import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetAdminKey, isUnlocked, unlockSettings } from '../../src/device/lib/adminKey';
import { ApiError } from '../../src/device/lib/api';
import { deviceStatus } from '../../src/device/mocks/fixtures';
import { withAccess } from '../../src/device/state/access';
import { answerCredential, credentialAsked } from '../../src/shared/credentialGate';
import { answering } from './answering';

beforeEach(() => {
  forgetAdminKey();
  answering(deviceStatus({ auth_required: true }));
});

afterEach(() => {
  if (credentialAsked.value) answerCredential(false);
});

/** Answer the dialog once the write has asked, as a person would. */
async function answerWhenAsked(accepted: boolean): Promise<void> {
  await vi.waitFor(() => expect(credentialAsked.value).toBe(true));
  if (accepted) unlockSettings('key', false);
  answerCredential(accepted);
}

describe('withAccess', () => {
  it('writes at once while unlocked', async () => {
    unlockSettings('key', false);
    await expect(withAccess(async () => 'saved')).resolves.toBe('saved');
    expect(credentialAsked.value).toBe(false);
  });

  it('writes at once to a device that has no key yet', async () => {
    answering(deviceStatus({ mode: 'setup', auth_required: false }));
    await expect(withAccess(async () => 'saved')).resolves.toBe('saved');
    expect(credentialAsked.value).toBe(false);
  });

  it('asks for the key while locked, then writes', async () => {
    const write = vi.fn(async () => 'saved');
    const result = withAccess(write);
    expect(write).not.toHaveBeenCalled();
    await answerWhenAsked(true);
    await expect(result).resolves.toBe('saved');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when the person declines', async () => {
    const write = vi.fn(async () => 'saved');
    const result = withAccess(write);
    await answerWhenAsked(false);
    await expect(result).resolves.toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it('shares one question between writes that ask together', async () => {
    const first = withAccess(async () => 'first');
    const second = withAccess(async () => 'second');
    await answerWhenAsked(true);
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
  });

  it('asks again when the device refuses the key, and retries once', async () => {
    unlockSettings('stale', false);
    const write = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ApiError(401, 'unauthorized'))
      .mockResolvedValueOnce('saved');
    const result = withAccess(write);
    await answerWhenAsked(true);
    await expect(result).resolves.toBe('saved');
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('locks and stops when the refused key is not replaced', async () => {
    unlockSettings('stale', false);
    const result = withAccess(async () => {
      throw new ApiError(401, 'unauthorized');
    });
    await answerWhenAsked(false);
    await expect(result).resolves.toBeNull();
    expect(isUnlocked()).toBe(false);
  });

  it('passes every other failure to the caller', async () => {
    unlockSettings('key', false);
    await expect(
      withAccess(async () => {
        throw new ApiError(409, 'a firmware update is running');
      }),
    ).rejects.toThrow('a firmware update is running');
  });
});
