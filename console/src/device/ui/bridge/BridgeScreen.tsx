import {
  Button,
  buttonClass,
  Card,
  CardBody,
  CardHead,
  Content,
  EmptyState,
  Fact,
  Facts,
  Notice,
  OptionCards,
} from 'linen';
import { useState } from 'react';
import { bridgeSourcesLink } from '../../lib/consoleAddress';
import { audioActivity } from '../../state/activity';
import { rememberedBridgeConsole } from '../../state/bridgeConsole';
import { delivery } from '../../state/delivery';
import { config, configResource, liveStatus, status } from '../../state/device';
import { episodeDrops, lossCalloutVisible } from '../../state/streamLoss';
import { ActivityStatus } from '../activityWords';
import { ResourceNotice } from '../ResourceNotice';
import { ScreenTop } from '../ScreenTop';
import { TargetDialog } from './TargetDialog';

export function BridgeScreen() {
  const [connecting, setConnecting] = useState(false);
  const known = status.value;
  const facts = known ? delivery(known, config.value) : null;
  return (
    <>
      <ScreenTop title="Bridge" meta={<ActivityStatus activity={audioActivity.value} />} />
      <Content>
        <div className="grid gap-4">
          <ResourceNotice resource={configResource} />
          {facts ? (
            <>
              <Card>
                <CardHead title="Destination" description="Where the device sends its audio.">
                  <Button onClick={() => setConnecting(true)}>Change bridge</Button>
                </CardHead>
                <CardBody>
                  <Facts>
                    <Fact
                      name="Address"
                      mono
                      copy={{ value: facts.address, label: 'Bridge address' }}
                    >
                      {facts.address}
                    </Fact>
                    <Fact name="Encryption">
                      {facts.encrypted ? 'On' : 'Off: audio crosses the network in the clear'}
                    </Fact>
                    {facts.source && (
                      <Fact name="Name on the bridge" mono>
                        {facts.source}
                      </Fact>
                    )}
                  </Facts>
                </CardBody>
              </Card>
              <Reception source={facts.source} address={facts.address} />
              <Delivery />
            </>
          ) : (
            <NoBridge onConnect={() => setConnecting(true)} />
          )}
        </div>
      </Content>
      {connecting && <TargetDialog open={connecting} onOpenChange={setConnecting} />}
    </>
  );
}

/** Sending is the device's fact; whether audio arrives is the bridge's to show. */
function Reception({ source, address }: { source: string | null; address: string }) {
  const kept = rememberedBridgeConsole(address);
  const link = kept ? bridgeSourcesLink(kept, source ?? undefined) : undefined;
  return (
    <Card>
      <CardHead
        title="Reception"
        description="The bridge console shows whether audio arrives, and the address a player opens."
      >
        {link && (
          <a className={buttonClass()} href={link} target="_blank" rel="noreferrer">
            Open in the bridge console
          </a>
        )}
      </CardHead>
      {!link && (
        <CardBody>
          <p className="text-sm text-text-secondary">
            Add the bridge console's address under Change bridge to link straight to this device's
            source there.
          </p>
        </CardBody>
      )}
    </Card>
  );
}

function Delivery() {
  const live = liveStatus.value;
  const facts = live ? delivery(live, config.value) : null;
  return (
    <Card>
      <CardHead
        title="Delivery"
        description="How the link to the bridge has held since the device started."
      />
      <CardBody>
        {lossCalloutVisible.value && (
          <Notice
            className="mb-4"
            tone="warn"
            title={`${episodeDrops.value} packets of audio were lost recently.`}
            description="A listener hears these as gaps. The counters below say where they went."
          />
        )}
        {facts ? (
          <Facts>
            <Fact name="Reconnections">{facts.reconnects}</Fact>
            <Fact name="Network errors">{facts.networkErrors}</Fact>
            {facts.encrypted && <Fact name="Failed handshakes">{facts.handshakeFailures}</Fact>}
            <Fact name="Longest stall">{facts.longestStallMs} ms</Fact>
            <Fact name="Packets lost">{facts.dropped}</Fact>
          </Facts>
        ) : (
          <p className="text-sm text-text-secondary">
            Live counters return when the device answers.
          </p>
        )}
      </CardBody>
    </Card>
  );
}

type Install = 'home-assistant' | 'docker' | 'existing';

const INSTALL: Record<Install, { label: string; description: string; steps: string }> = {
  'home-assistant': {
    label: 'Home Assistant',
    description: 'The StreamLine Bridge app runs beside Music Assistant.',
    steps:
      'Add the StreamLine repository under Settings → Apps in Home Assistant, install StreamLine Bridge, start it, then search for it here.',
  },
  docker: {
    label: 'Docker',
    description: 'The bridge image on any computer that stays on.',
    steps:
      'Run the bridge with the Compose file from the StreamLine README on a computer on this network, then search for it here.',
  },
  existing: {
    label: 'A bridge I already run',
    description: 'Point the device at it.',
    steps: 'Search for it here, or type its address and port.',
  },
};

function NoBridge({ onConnect }: { onConnect: () => void }) {
  const [install, setInstall] = useState<Install | undefined>(undefined);
  return (
    <>
      <Card>
        <EmptyState
          title="No bridge yet"
          description="Capture and levels work without one. A bridge turns the input into a stream your players can open."
        >
          <Button variant="primary" onClick={onConnect}>
            Connect a bridge
          </Button>
        </EmptyState>
      </Card>
      <Card>
        <CardHead title="Install a bridge" description="Where the bridge will run." />
        <CardBody>
          <OptionCards
            label="Where the bridge runs"
            options={(Object.keys(INSTALL) as Install[]).map((value) => ({
              value,
              label: INSTALL[value].label,
              description: INSTALL[value].description,
            }))}
            value={install}
            onValueChange={setInstall}
          />
          {install && <p className="mt-4 text-sm">{INSTALL[install].steps}</p>}
        </CardBody>
      </Card>
    </>
  );
}
