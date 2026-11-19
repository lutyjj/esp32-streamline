import { useMutation, useQuery } from '@tanstack/preact-query';
import {
  Button,
  buttonClass,
  Card,
  CardBody,
  CardHead,
  Content,
  CopyValue,
  EmptyState,
  Fact,
  Facts,
  FormDialog,
  Gauge,
  Gauges,
  ShownOnce,
  Status,
  TextField,
} from 'linen';
import { useState } from 'react';
import type { BridgeStatus, SourceSnapshot } from '../../../generated/bridge';
import { LEVEL_FLOOR_DB, LEVEL_ZONES, levelDb, levelText } from '../../../shared/format';
import { fieldErrors } from '../../../shared/http';
import { Link, navigate } from '../../../shared/navigation';
import { queryClient } from '../../../shared/queries';
import { ReadNotice } from '../../../shared/ReadNotice';
import { WriteFailure } from '../../../shared/WriteFailure';
import { whereToSet } from '../../lib/deployment';
import { musicAssistantStep } from '../../lib/musicAssistant';
import { playbackUrl } from '../../lib/playback';
import { quality, receptionAdvice, sourceState } from '../../lib/reception';
import { useReadOnly } from '../../state/access';
import { makePairingToken, revealedPairing } from '../../state/pairing';
import { capabilitiesQuery, statusQuery } from '../../state/queries';
import { record, titleProblem } from '../../state/recordings';
import { NeedsToken } from '../NeedsToken';
import { ScreenTop } from '../ScreenTop';

const TRAIL = [{ href: '/sources', label: 'Sources' }] as const;

/** One source: how it arrives, where a player opens it, Music Assistant, and recording it. */
export function SourceScreen({ id }: { id: string }) {
  const status = useQuery(statusQuery, queryClient);
  const source = status.data?.sources[id];
  if (!status.data || !source)
    return (
      <>
        <ScreenTop title={id} trail={TRAIL} />
        <Content>
          {status.data ? (
            <EmptyState
              title="This source is not on the bridge now"
              description="A source appears while its device streams here, and the bridge forgets one that stays away for a while."
            >
              <Link className={buttonClass()} href="/sources">
                All sources
              </Link>
            </EmptyState>
          ) : (
            <ReadNotice read={status} name="bridge status" />
          )}
        </Content>
      </>
    );
  const state = sourceState(source);
  return (
    <>
      <ScreenTop
        title={id}
        trail={TRAIL}
        meta={<Status tone={status.isError ? 'unknown' : state.tone}>{state.label}</Status>}
      />
      <Content>
        <Reception source={source} live={!status.isError} />
        <Listen id={id} known={status.data} />
        <MusicAssistant id={id} known={status.data} />
        <Record id={id} />
      </Content>
    </>
  );
}

/** A source's peak on each channel; `compact` for a row of a list. */
export function ReceivedLevel({
  source,
  compact,
  className,
}: {
  source: SourceSnapshot;
  compact?: boolean;
  className?: string;
}) {
  return (
    <Gauges label="Received level" compact={compact} className={className}>
      {(['left', 'right'] as const).map((side) => (
        <Gauge
          key={side}
          label={side === 'left' ? 'Left' : 'Right'}
          value={levelDb(source.levels[`peak_${side}`])}
          min={LEVEL_FLOOR_DB}
          max={0}
          zones={LEVEL_ZONES}
          format={levelText}
        />
      ))}
    </Gauges>
  );
}

function Reception({ source, live }: { source: SourceSnapshot; live: boolean }) {
  const reached = quality(source);
  const encrypted = source.lifecycle.transport === 'tls-psk';
  return (
    <Card>
      <CardHead title="Reception" description={receptionAdvice(source)} />
      <CardBody>
        {live ? (
          <ReceivedLevel source={source} />
        ) : (
          <p className="text-sm text-text-secondary">Live levels return when the bridge answers.</p>
        )}
        <Facts>
          <Fact name="Last minute">
            <Status tone={reached.tone}>{reached.label}</Status>
          </Fact>
          <Fact name="Transport">{encrypted ? 'Encrypted, with its credential' : 'Cleartext'}</Fact>
          {encrypted && (
            <Fact name="Device address" mono>
              {source.lifecycle.peer_ip}
            </Fact>
          )}
          <Fact name="Players">{source.clients}</Fact>
        </Facts>
      </CardBody>
    </Card>
  );
}

function Listen({ id, known }: { id: string; known: BridgeStatus }) {
  const address = playbackUrl(known.public_url ?? '', window.location.href, id);
  return (
    <Card>
      <CardHead
        title="Listen"
        description={
          address
            ? 'Open this address in a player that plays HTTP WAV streams. The console itself plays nothing.'
            : `This console opens through a path a player cannot use. Set ${whereToSet('publicUrl')} to the address players reach the bridge at, then restart the bridge.`
        }
      />
      {address && (
        <CardBody>
          <CopyValue value={address} label="Playback address" />
        </CardBody>
      )}
    </Card>
  );
}

function MusicAssistant({ id, known }: { id: string; known: BridgeStatus }) {
  const make = useMutation({ mutationFn: () => makePairingToken(id) }, queryClient);
  const readOnly = useReadOnly();
  const published = known.sendspin.sources.find((source) => source.source === id);
  if (!known.sendspin.enabled || !published)
    return (
      <Card>
        <CardHead
          title="Music Assistant"
          description={
            known.sendspin.enabled
              ? 'This source joins Music Assistant once its device has connected.'
              : `Publishing to Music Assistant is off. Set ${whereToSet('sendspin')}, then restart the bridge, to offer every source as a Live Input.`
          }
        />
      </Card>
    );
  const step = musicAssistantStep(published);
  const shown = revealedPairing.value?.source === id ? revealedPairing.value : null;
  return (
    <Card>
      <CardHead
        title="Music Assistant"
        aside={<Status tone={step.tone}>{step.label}</Status>}
        description={step.detail}
      >
        {readOnly ? null : shown === null ? (
          <Button
            variant={step.pairs ? 'primary' : 'default'}
            busy={make.isPending}
            onClick={() => make.mutate()}
          >
            {step.pairs ? 'Make pairing token' : 'Make a new pairing token'}
          </Button>
        ) : (
          <Button onClick={() => (revealedPairing.value = null)}>Done</Button>
        )}
      </CardHead>
      {(readOnly || make.error || shown) && (
        <CardBody>
          {readOnly && <NeedsToken change="Pairing" />}
          {make.error && <WriteFailure failed="No pairing token was made." error={make.error} />}
          {shown && (
            <ShownOnce
              title="Pairing token"
              description={`Paste it into the setup of “${published.name}” in Music Assistant. Locking the console hides it.`}
              label="Pairing token"
              secret={shown.token}
              copyLabel="Copy pairing token"
              lost="Making another replaces it. A pairing already made keeps working."
            />
          )}
        </CardBody>
      )}
    </Card>
  );
}

function Record({ id }: { id: string }) {
  const capabilities = useQuery(capabilitiesQuery, queryClient);
  const readOnly = useReadOnly();
  const [asking, setAsking] = useState(false);
  if (!capabilities.data) return null;
  if (!capabilities.data.enabled)
    return (
      <Card>
        <CardHead
          title="Record"
          description={`Recording is off. Set ${whereToSet('recordings')}, then restart the bridge.`}
        />
      </Card>
    );
  return (
    <Card>
      <CardHead
        title="Record"
        description="A lossless WAV of what the bridge receives from this source, kept on the bridge until you delete it."
      >
        {!readOnly && <Button onClick={() => setAsking(true)}>Record this source</Button>}
      </CardHead>
      {readOnly && (
        <CardBody>
          <NeedsToken change="Recording" />
        </CardBody>
      )}
      {asking && (
        <RecordDialog
          source={id}
          limit={capabilities.data.limits.max_title_chars}
          onClose={() => setAsking(false)}
        />
      )}
    </Card>
  );
}

/** The title of a recording of `source`; it starts with the bridge's answer and opens Recordings. */
function RecordDialog({
  source,
  limit,
  onClose,
}: {
  source: string;
  limit: number;
  onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const start = useMutation(
    {
      mutationFn: () => record(source, title.trim()),
      onSuccess: (started) => {
        setErrors({});
        if (started) navigate('/recordings');
      },
      onError: (error) => setErrors(fieldErrors(error, ['title'])),
    },
    queryClient,
  );
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Record this source"
      description="Recording starts with the first audio the bridge receives. Start it before the passage you want."
      confirmLabel="Start recording"
      disabled={title.trim() === ''}
      errors={errors}
      onConfirm={() => start.mutateAsync().catch(() => undefined)}
    >
      <TextField
        label="Title"
        name="title"
        autoFocus
        value={title}
        validate={(value) => titleProblem(String(value ?? ''), limit)}
        onChange={(event) => setTitle(event.currentTarget.value)}
      />
      {start.error && Object.keys(errors).length === 0 && (
        <WriteFailure failed="The recording did not start." error={start.error} />
      )}
    </FormDialog>
  );
}
