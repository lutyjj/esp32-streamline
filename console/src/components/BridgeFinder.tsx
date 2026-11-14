import { useEffect } from 'preact/hooks';
import type { DiscoveredBridge } from '../lib/api';
import { discovery, fillsTarget, findBridges } from '../state/discovery';
import { Button } from './Button';
import { Chip } from './Chip';

/**
 * The bridges the device found on its network, each offered as a stream
 * target. Use fills the target fields through `onUse`; the form's own save
 * writes them, so typing an address always stays possible.
 */
export function BridgeFinder({
  host,
  port,
  disabled,
  searchOnOpen = false,
  onUse,
}: {
  host: string;
  port: string;
  disabled: boolean;
  /** Start a search when the finder appears, as a guided step does. */
  searchOnOpen?: boolean;
  onUse: (bridge: DiscoveredBridge) => void;
}) {
  useEffect(() => {
    if (searchOnOpen) void findBridges();
  }, [searchOnOpen]);

  const found = discovery.value;
  const searching = found.phase === 'searching';
  const lead =
    found.phase === 'idle'
      ? 'The device can look for bridges on your network.'
      : found.phase === 'searching'
        ? 'Looking for bridges on your network…'
        : found.phase === 'failed'
          ? `Couldn’t search the network: ${found.reason}. Enter the bridge’s address instead.`
          : found.bridges.length === 0
            ? 'No bridge answered. Some networks block discovery; enter the bridge’s address instead.'
            : found.bridges.length === 1
              ? 'Found one bridge on your network.'
              : `Found ${found.bridges.length} bridges on your network.`;

  return (
    <div class="bridgefinder" aria-live="polite">
      <div class="wizentry">
        <span>{lead}</span>
        <Button busy={searching} onClick={() => void findBridges()}>
          {found.phase === 'idle' ? 'Find bridges' : 'Search again'}
        </Button>
      </div>
      {found.phase === 'found' && found.bridges.length > 0 && (
        <ul class="bridgelist">
          {found.bridges.map((bridge) => {
            const chosen = fillsTarget(bridge, host, port);
            return (
              <li key={bridge.name} class={`bridgerow${chosen ? ' chosen' : ''}`}>
                <span class="bridgerow-copy">
                  <span class="bridgerow-name">{bridge.name}</span>
                  <span class="bridgerow-address">
                    {bridge.host}:{bridge.port}
                  </span>
                </span>
                {chosen ? (
                  <Chip tone="good">Entered below</Chip>
                ) : (
                  <Button
                    disabled={disabled}
                    aria-label={`Use ${bridge.name}`}
                    onClick={() => onUse(bridge)}
                  >
                    Use
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
