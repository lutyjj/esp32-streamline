import { useQuery } from '@tanstack/preact-query';
import { Actions, Button, Content, EmptyState } from 'linen';
import { useState } from 'react';
import type { BridgeStatus, RecordingCapabilities, RecordingList } from '../../../generated/bridge';
import { requestCredential } from '../../../shared/credentialGate';
import { queryClient } from '../../../shared/queries';
import { ReadNotice } from '../../../shared/ReadNotice';
import { whereToSet } from '../../lib/deployment';
import { heldToken } from '../../lib/token';
import { useReadOnly } from '../../state/access';
import { capabilitiesQuery, recordingsQuery, statusQuery } from '../../state/queries';
import { recordingRoom } from '../../state/recordings';
import { ScreenTop } from '../ScreenTop';
import { Library } from './Library';
import { NewRecording } from './NewRecording';
import { Session } from './Session';

/** Capture and the file library, apart: a session in progress takes the new recording's place. */
export function RecordingsScreen() {
  const capabilities = useQuery(capabilitiesQuery, queryClient);
  const unlocked = heldToken.value !== '';
  const enabled = capabilities.data?.enabled === true;
  const list = useQuery({ ...recordingsQuery, enabled: unlocked && enabled }, queryClient);
  const status = useQuery(statusQuery, queryClient);
  const readOnly = useReadOnly();
  return (
    <>
      <ScreenTop title="Recordings" />
      <Content>
        {!capabilities.data ? (
          <ReadNotice read={capabilities} name="recording settings" />
        ) : !enabled ? (
          <EmptyState
            title="Recording is off"
            description={`The bridge records a source as a lossless WAV file once its deployment gives it storage. Set ${whereToSet('recordings')}, then restart the bridge.`}
          />
        ) : readOnly ? (
          <EmptyState
            title="Recordings need the bridge API token"
            description={`Set ${whereToSet('token')}, then restart the bridge.`}
          />
        ) : !unlocked ? (
          <EmptyState
            title="Seeing recordings needs the bridge API token"
            description="The bridge lists sessions and files only to whoever holds it."
          >
            <Button onClick={() => void requestCredential()}>Unlock to see recordings</Button>
          </EmptyState>
        ) : list.data ? (
          <Recordings list={list.data} capabilities={capabilities.data} known={status.data} />
        ) : (
          <ReadNotice read={list} name="recordings" />
        )}
      </Content>
    </>
  );
}

function Recordings({
  list,
  capabilities,
  known,
}: {
  list: RecordingList;
  capabilities: RecordingCapabilities;
  known: BridgeStatus | undefined;
}) {
  const [adding, setAdding] = useState(false);
  const room = recordingRoom(list, capabilities);
  return (
    <>
      {list.active.map((session) => (
        <Session key={session.id} session={session} room={room} />
      ))}
      {list.active.length === 0 || adding ? (
        <NewRecording
          known={known}
          busy={list.active.map((session) => session.source)}
          limit={capabilities.limits.max_title_chars}
          room={room}
          onStarted={() => setAdding(false)}
        />
      ) : (
        <Actions>
          <Button onClick={() => setAdding(true)}>New recording</Button>
        </Actions>
      )}
      <Library saved={list.saved} />
    </>
  );
}
