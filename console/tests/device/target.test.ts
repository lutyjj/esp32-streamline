import { describe, expect, it } from 'vitest';
import { bridgeSourcesLink, consoleAddressProblem } from '../../src/device/lib/consoleAddress';
import { targetProblems, targetRequest } from '../../src/device/lib/target';

// Stage 2: host and port are one form, but the device stores them apart, so a
// host that carries its own port, scheme or path is refused rather than split.
describe('targetProblems', () => {
  it('passes a bare name or address with a port, trimming space', () => {
    expect(targetProblems({ host: '  bridge.local ', port: ' 39000 ' })).toEqual([]);
    expect(targetRequest({ host: '  bridge.local ', port: ' 39000 ' })).toEqual({
      target_host: 'bridge.local',
      target_port: 39000,
    });
  });

  it('refuses a host that carries a port, scheme, path or space', () => {
    const hostText = (host: string) =>
      targetProblems({ host, port: '39000' }).map((problem) => problem.text);
    expect(hostText('bridge.local:39000')).toEqual(['Put the port in its own field.']);
    expect(hostText('http://bridge.local')).toEqual([expect.stringContaining('http://')]);
    expect(hostText('bridge.local/stream')).toEqual([expect.stringContaining('path')]);
    expect(hostText('my bridge')).toEqual([expect.stringContaining('spaces')]);
    expect(hostText('')).toEqual([expect.stringContaining('name or address')]);
  });

  it('takes a port from 1 to 65535 and nothing else', () => {
    for (const port of ['', '0', '65536', '39000.5', '-1', 'http']) {
      expect(targetProblems({ host: 'bridge.local', port })).toEqual([
        { field: 'port', text: expect.stringContaining('1 to 65535') },
      ]);
    }
    expect(targetProblems({ host: 'bridge.local', port: '65535' })).toEqual([]);
  });
});

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
