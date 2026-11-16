import { useQuery } from '@tanstack/preact-query';
import {
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
  SettingRow,
} from 'linen';
import { useEffect, useState } from 'react';
import { Link, replacePath, usePathname } from '../../../shared/navigation';
import { bridgeSourcesLink } from '../../lib/consoleAddress';
import { audioActivity } from '../../state/activity';
import { rememberedBridgeConsole } from '../../state/bridgeConsole';
import { delivery } from '../../state/delivery';
import { liveStatus, status } from '../../state/device';
import { queryClient, settingsQuery } from '../../state/queries';
import { episodeDrops, lossCalloutVisible } from '../../state/streamLoss';
import { ActivityStatus } from '../activityWords';
import { sectionOf } from '../places';
import { ReadNotice } from '../ReadNotice';
import { ScreenTop } from '../ScreenTop';
import { EncryptionScreen } from './EncryptionScreen';
import { TargetScreen } from './TargetScreen';

/** The Bridge place: where the audio goes and how delivery holds, and the task that changes it. */
export function BridgeScreen() {
  const task = sectionOf(usePathname());
  useEffect(() => {
    if (task !== undefined && task !== 'target' && task !== 'encryption') replacePath('/bridge');
  }, [task]);
  if (task === 'target') return <TargetScreen />;
  if (task === 'encryption') return <EncryptionScreen />;
  return <BridgeOverview />;
}

/** Whether the audio crosses the network encrypted, and the way to change it. */
function EncryptionRow({ encrypted, staged }: { encrypted: boolean; staged: boolean }) {
  return (
    <SettingRow
      title="Encryption"
      description={
        staged
          ? 'Setup is under way with a credential the device made.'
          : encrypted
            ? 'On: the bridge knows this device by its credential.'
            : 'Off: audio crosses the network in the clear.'
      }
    >
      <Link href="/bridge/encryption" className={buttonClass()}>
        {staged ? 'Resume setup' : encrypted ? 'Manage' : 'Set up encryption'}
      </Link>
    </SettingRow>
  );
}

function BridgeOverview() {
  const known = status.value;
  const settings = useQuery(settingsQuery, queryClient);
  const facts = known ? delivery(known, settings.data ?? null) : null;
  return (
    <>
      <ScreenTop title="Bridge" meta={<ActivityStatus activity={audioActivity.value} />} />
      <Content>
        <div className="grid gap-4">
          <ReadNotice read={settings} name="device settings" />
          {facts ? (
            <>
              <Card>
                <CardHead title="Destination" description="Where the device sends its audio.">
                  <Link href="/bridge/target" className={buttonClass()}>
                    Change bridge
                  </Link>
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
                    {facts.source && (
                      <Fact name="Name on the bridge" mono>
                        {facts.source}
                      </Fact>
                    )}
                  </Facts>
                </CardBody>
                <EncryptionRow
                  encrypted={facts.encrypted}
                  staged={Boolean(settings.data?.transport.pending_key_id)}
                />
              </Card>
              <Reception source={facts.source} address={facts.address} />
              <Delivery />
            </>
          ) : (
            <NoBridge />
          )}
        </div>
      </Content>
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
  const settings = useQuery(settingsQuery, queryClient).data ?? null;
  const facts = live ? delivery(live, settings) : null;
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
      'Add the StreamLine repository under Settings → Apps in Home Assistant, install StreamLine Bridge, start it, then connect it here.',
  },
  docker: {
    label: 'Docker',
    description: 'The bridge image on any computer that stays on.',
    steps:
      'Run the bridge with the Compose file from the StreamLine README on a computer on this network, then connect it here.',
  },
  existing: {
    label: 'A bridge I already run',
    description: 'Point the device at it.',
    steps: 'Connect it here by its address and port.',
  },
};

function NoBridge() {
  const [install, setInstall] = useState<Install | undefined>(undefined);
  return (
    <>
      <Card>
        <EmptyState
          title="No bridge yet"
          description="Capture and levels work without one. A bridge turns the input into a stream your players can open."
        >
          <Link href="/bridge/target" className={buttonClass('primary')}>
            Connect a bridge
          </Link>
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
