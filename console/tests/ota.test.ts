import { describe, expect, it } from 'vitest';
import { customImageProblem, expectedVersion, updateRecovery } from '../src/state/ota';

describe('updateRecovery', () => {
  it('is applied when the version advanced to the release we aimed for', () => {
    expect(updateRecovery('0.4.0', '0.5.0', '0.5.0')).toBe('applied');
  });

  it('is applied when a custom image booted a different version', () => {
    // No expected release, but the version changed, so the new image is running.
    expect(updateRecovery('0.4.0', '', '0.4.1-dev')).toBe('applied');
  });

  it('is rolled back when a newer release was aimed for but the old version returned', () => {
    // The bootloader reverted: the version that ran the install came back.
    expect(updateRecovery('0.4.0', '0.5.0', '0.4.0')).toBe('rolled-back');
  });

  it('is inconclusive when a same-version custom image returns', () => {
    // A reinstall and a revert look identical without a version change.
    expect(updateRecovery('0.4.0', '', '0.4.0')).toBe('inconclusive');
  });
});

describe('custom image validation', () => {
  const sha = 'a'.repeat(64);

  it.each([
    ['', '', 'enter both'],
    ['http://host/image.bin', '', 'enter both'],
    ['', sha, 'enter both'],
    ['not a url', sha, 'http(s) address'],
    ['ftp://host/image.bin', sha, 'http or https'],
    ['http://user:secret@host/image.bin', sha, 'username or password'],
    ['https://host/image.bin#fragment', sha, '#fragment'],
    ['http://host/image.bin', 'abc123', '64 hex'],
  ])('rejects %j / %j before any request', (url, digest, problem) => {
    expect(customImageProblem(url, digest)).toContain(problem);
  });

  it('accepts a full http(s) source pinned by a 64-hex digest', () => {
    expect(customImageProblem('http://192.0.2.10:8000/streamline-ota.bin', sha)).toBeNull();
    expect(customImageProblem('https://host/image.bin', sha.toUpperCase())).toBeNull();
    // A signed query is the point of a custom URL; it must stay accepted.
    expect(customImageProblem('https://host/image.bin?token=abc&part=1', sha)).toBeNull();
  });
});

describe('install source and recovery expectation', () => {
  it('lets a release install expect the release version', () => {
    expect(expectedVersion('release', '0.7.3')).toBe('0.7.3');
  });

  it('gives a custom install no expected version, so recovery is observed', () => {
    // Stale release metadata must not classify a same-version custom image
    // as a rollback.
    expect(expectedVersion('custom', '0.7.3')).toBe('');
    expect(updateRecovery('0.7.2', expectedVersion('custom', '0.7.3'), '0.7.2')).toBe(
      'inconclusive',
    );
  });
});
