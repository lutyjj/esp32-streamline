import { render } from 'preact';
import { act } from 'preact/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { BridgeFinder } from '../src/components/BridgeFinder';
import type { DiscoveredBridge } from '../src/lib/api';
import { discoveredBridges } from '../src/mocks/fixtures';
import { discovery } from '../src/state/discovery';

function finder(props: { host?: string; port?: string; disabled?: boolean } = {}) {
  const used: DiscoveredBridge[] = [];
  const host = document.createElement('div');
  render(
    <BridgeFinder
      host={props.host ?? ''}
      port={props.port ?? '39000'}
      disabled={props.disabled ?? false}
      onUse={(bridge) => used.push(bridge)}
    />,
    host,
  );
  return { host, used };
}

function buttons(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll('button')];
}

describe('BridgeFinder', () => {
  beforeEach(() => {
    discovery.value = { phase: 'idle' };
  });

  it('offers a search before one has run', () => {
    const { host } = finder();

    expect(buttons(host).map((button) => button.textContent)).toEqual(['Find bridges']);
  });

  it('narrates a running search and holds its button', () => {
    discovery.value = { phase: 'searching' };
    const { host } = finder();

    expect(host.textContent).toContain('Looking for bridges on your network');
    expect(buttons(host)[0].disabled).toBe(true);
  });

  it('sends the owner to manual entry when no bridge answers', () => {
    discovery.value = { phase: 'found', bridges: [] };
    const { host } = finder();

    expect(host.textContent).toContain('No bridge answered');
    expect(host.textContent).toContain('enter the bridge’s address instead');
    expect(host.querySelector('.bridgelist')).toBeNull();
  });

  it('names a failed search and its manual fallback', () => {
    discovery.value = { phase: 'failed', reason: 'bridge discovery failed' };
    const { host } = finder();

    expect(host.textContent).toContain('Couldn’t search the network: bridge discovery failed.');
    expect(buttons(host).map((button) => button.textContent)).toEqual(['Search again']);
  });

  it('lists one bridge and fills the target only when asked', () => {
    const [bridge] = discoveredBridges();
    discovery.value = { phase: 'found', bridges: [bridge] };
    const { host, used } = finder();

    expect(host.textContent).toContain('Found one bridge on your network.');
    expect(used).toEqual([]);
    act(() => host.querySelector<HTMLButtonElement>(`[aria-label="Use ${bridge.name}"]`)?.click());

    expect(used).toEqual([bridge]);
  });

  it('lists several bridges and marks the one the fields already name', () => {
    const bridges = discoveredBridges();
    discovery.value = { phase: 'found', bridges };
    const { host } = finder({ host: bridges[1].host, port: String(bridges[1].port) });

    expect(host.textContent).toContain(`Found ${bridges.length} bridges on your network.`);
    const rows = [...host.querySelectorAll('.bridgerow')];
    expect(rows.map((row) => row.querySelector('.bridgerow-name')?.textContent)).toEqual(
      bridges.map((bridge) => bridge.name),
    );
    expect(rows[1].textContent).toContain('Entered below');
    expect(rows[1].querySelector('button')).toBeNull();
    expect(rows[0].querySelector('button')?.textContent).toBe('Use');
  });

  it('keeps Use locked while settings are locked', () => {
    discovery.value = { phase: 'found', bridges: discoveredBridges() };
    const { host } = finder({ disabled: true });

    const uses = buttons(host).filter((button) => button.textContent === 'Use');
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((button) => button.disabled)).toBe(true);
  });
});
