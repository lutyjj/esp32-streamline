import { useQuery } from '@tanstack/preact-query';
import { Card, Content, EmptyState, LINK_CLASS, SettingRow, Status } from 'linen';
import type { BridgeStatus } from '../../../generated/bridge';
import { Link, usePathname } from '../../../shared/navigation';
import { queryClient } from '../../../shared/queries';
import { ReadNotice } from '../../../shared/ReadNotice';
import { musicAssistantStep } from '../../lib/musicAssistant';
import { sourceState } from '../../lib/reception';
import { statusQuery } from '../../state/queries';
import { itemOf } from '../places';
import { ScreenTop } from '../ScreenTop';
import { ReceivedLevel, SourceScreen } from './SourceScreen';

/** Every source the bridge knows, or one of them (`#/sources/<id>`). */
export function SourcesScreen() {
  const id = itemOf(usePathname());
  return id === undefined ? <SourceList /> : <SourceScreen id={id} />;
}

function SourceList() {
  const status = useQuery(statusQuery, queryClient);
  return (
    <>
      <ScreenTop title="Sources" />
      <Content>
        {status.data ? (
          <Sources known={status.data} />
        ) : (
          <ReadNotice read={status} name="bridge status" />
        )}
      </Content>
    </>
  );
}

function Sources({ known }: { known: BridgeStatus }) {
  const sources = Object.entries(known.sources).sort(([a], [b]) => a.localeCompare(b));
  if (sources.length === 0)
    return (
      <Card>
        <EmptyState
          title="No device is sending audio yet"
          description={`A device appears here once it streams to this bridge on port ${known.transport.port}, even while its input is quiet. Set the bridge as its target in the device console, with streaming on.`}
        />
      </Card>
    );
  const published = new Map(known.sendspin.sources.map((source) => [source.source, source]));
  return (
    <Card>
      {/* biome-ignore lint/a11y/useSemanticElements: SettingRow is a div with the listitem role, which a <ul> may not hold. */}
      <div role="list" aria-label="Sources">
        {sources.map(([id, source]) => {
          const state = sourceState(source);
          const music = published.get(id);
          return (
            <SettingRow
              key={id}
              role="listitem"
              title={
                <Link
                  href={`/sources/${encodeURIComponent(id)}`}
                  className={`${LINK_CLASS} font-mono`}
                >
                  {id}
                </Link>
              }
              description={[
                source.lifecycle.transport === 'tls-psk' ? 'Encrypted' : 'Cleartext',
                music && `Music Assistant: ${musicAssistantStep(music).label.toLowerCase()}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            >
              {source.lifecycle.state === 'connected' ? (
                <ReceivedLevel source={source} compact className="w-24" />
              ) : (
                <Status tone={state.tone}>{state.label}</Status>
              )}
            </SettingRow>
          );
        })}
      </div>
    </Card>
  );
}
