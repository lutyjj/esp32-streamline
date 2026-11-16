import { describe, expect, it } from 'vitest';
import { bridgeSourcesLink, consoleAddressProblem } from '../../src/device/lib/consoleAddress';

describe('bridgeSourcesLink', () => {
  it('links to the sources, or to this device’s source, of a plain http address', () => {
    expect(bridgeSourcesLink('http://bridge.local:8088')).toBe(
      'http://bridge.local:8088/#/sources',
    );
    expect(bridgeSourcesLink(' http://192.0.2.20:8088/ ', 'eli1-00ab')).toBe(
      'http://192.0.2.20:8088/#/sources/eli1-00ab',
    );
  });

  it('refuses anything a link must not open', () => {
    for (const address of ['javascript:alert(1)', 'http://user:pw@bridge.local', 'bridge.local']) {
      expect(bridgeSourcesLink(address)).toBeUndefined();
    }
  });
});

describe('consoleAddressProblem', () => {
  it('refuses an address the console could not link to, and nothing typed', () => {
    expect(consoleAddressProblem('')).toBeNull();
    expect(consoleAddressProblem('http://192.0.2.20:8088/')).toBeNull();
    expect(consoleAddressProblem('ftp://192.0.2.20/')).toContain('http://');
    expect(consoleAddressProblem('http://owner:secret@192.0.2.20/')).toContain('http://');
  });
});
