import { useMutation, useQuery } from '@tanstack/preact-query';
import {
  Actions,
  Button,
  Card,
  CardBody,
  CardHead,
  Fact,
  Facts,
  Gauge,
  Gauges,
  LogView,
  SegmentedControl,
  SettingRow,
  SettingToggle,
  Status,
  type StatusTone,
  useToast,
} from 'linen';
import { useState } from 'react';
import type { CheckStatus, StatusResponse } from '../../../generated/api';
import { requestCredential } from '../../../shared/credentialGate';
import { bytes, duration } from '../../../shared/format';
import { queryClient } from '../../../shared/queries';
import { ReadNotice } from '../../../shared/ReadNotice';
import { saveFile } from '../../../shared/saveFile';
import { WriteConfirm } from '../../../shared/WriteConfirm';
import { writeFailure } from '../../../shared/writeFailure';
import { isUnlocked, useAuthEpoch } from '../../lib/adminKey';
import { coredumpImage, coredumpQuery, eraseCoredump } from '../../state/coredump';
import { liveStatus, status } from '../../state/device';
import { headroomZones } from '../../state/health';
import { FOLLOW_MS, logsQuery, logText } from '../../state/logs';

const CHECK_WORDS: Record<CheckStatus, { tone: StatusTone; word: string }> = {
  ok: { tone: 'positive', word: 'OK' },
  warn: { tone: 'warn', word: 'Warning' },
  fail: { tone: 'danger', word: 'Failed' },
};

/** What the device checked as it started, what it has left, and what it wrote down. */
export function DiagnosticsSection() {
  useAuthEpoch();
  const known = status.value;
  if (!known) return null;
  return (
    <>
      <HealthCard known={known} />
      <ResourcesCard />
      {isUnlocked() ? (
        <>
          <LogCard />
          <CoredumpCard />
        </>
      ) : (
        <Card>
          <CardHead
            title="Device log and crash dump"
            description="Reading them needs the admin key: they can hold network names, addresses, and the memory of a crash."
          >
            <Button onClick={() => void requestCredential()}>Unlock to read</Button>
          </CardHead>
        </Card>
      )}
      <Card>
        <CardHead
          title="Raw status"
          description="Everything the device reports, as a script reads it from /api/status."
        />
        <CardBody>
          <LogView
            label="Status JSON"
            text={JSON.stringify(known, null, 2)}
            filename="streamline-status.json"
          />
        </CardBody>
      </Card>
    </>
  );
}

function HealthCard({ known }: { known: StatusResponse }) {
  return (
    <Card>
      <CardHead
        title="Startup health"
        description={`Last restart: ${known.diagnostics.reset_reason}.`}
      />
      {known.health.checks.map((check) => (
        <SettingRow key={check.id} title={check.detail} description={check.remedy ?? undefined}>
          <Status tone={CHECK_WORDS[check.status].tone}>{CHECK_WORDS[check.status].word}</Status>
        </SettingRow>
      ))}
    </Card>
  );
}

function ResourcesCard() {
  const live = liveStatus.value;
  if (!live) return null;
  const { heap, nvs, uptime_seconds: uptime, task_count: tasks } = live.system;
  return (
    <Card>
      <CardHead title="Resources" />
      <CardBody>
        <Gauges label="In use">
          <Gauge
            label="Memory"
            value={heap.total_bytes - heap.free_bytes}
            max={heap.total_bytes}
            zones={headroomZones(heap.total_bytes)}
            marks={[
              {
                value: heap.total_bytes - heap.minimum_free_bytes,
                kind: 'held',
                label: 'Most in use since the start',
              },
            ]}
            format={(used) => `${bytes(used)} of ${bytes(heap.total_bytes)}`}
          />
          <Gauge
            label="Settings storage"
            value={nvs.used_entries}
            max={nvs.total_entries}
            zones={headroomZones(nvs.total_entries)}
            format={(used) => `${used} of ${nvs.total_entries} entries`}
          />
        </Gauges>
        <Facts>
          <Fact name="Running for">{duration(uptime)}</Fact>
          <Fact name="Largest free block">{bytes(heap.largest_free_block_bytes)}</Fact>
          <Fact name="Tasks">{tasks}</Fact>
        </Facts>
      </CardBody>
    </Card>
  );
}

function LogCard() {
  const [following, setFollowing] = useState(false);
  const [boot, setBoot] = useState<'current' | 'previous'>('current');
  const read = useQuery(
    { ...logsQuery, refetchInterval: following ? FOLLOW_MS : false },
    queryClient,
  );
  const log = read.data;
  const view = boot === 'previous' && log?.previous ? log.previous : log?.current;
  return (
    <Card>
      <CardHead
        title="Device log"
        description="Kept in the device's memory, for this start and the one before."
      >
        {log?.previous && (
          <SegmentedControl
            label="Which start"
            value={boot}
            options={[
              { value: 'current', label: 'This start' },
              { value: 'previous', label: 'The one before' },
            ]}
            onValueChange={setBoot}
          />
        )}
      </CardHead>
      <SettingToggle
        title="Follow"
        description="Reads the log again every few seconds while this page is open."
        label="Follow the log"
        checked={following}
        onCheckedChange={setFollowing}
      />
      <CardBody>
        <ReadNotice read={read} name="device log" />
        {view && (
          <LogView
            label={view === log?.previous ? 'Log of the start before' : 'Log of this start'}
            text={logText(view)}
            filename={`streamline-log-${view.boot}.txt`}
          />
        )}
      </CardBody>
    </Card>
  );
}

function CoredumpCard() {
  const toast = useToast();
  const [eraseAsked, setEraseAsked] = useState(false);
  const read = useQuery(coredumpQuery, queryClient);
  const download = useMutation(
    {
      mutationFn: coredumpImage,
      onSuccess: (image) => {
        if (image) saveFile(image, 'streamline-coredump.bin');
      },
      onError: (error) => {
        const words = writeFailure(error, 'The crash dump did not download.', 'device');
        toast.show({ text: `${words.title} ${words.description}`, sticky: true });
      },
    },
    queryClient,
  );
  const dump = read.data;
  return (
    <Card>
      <CardHead
        title="Crash dump"
        description="A panic leaves a copy of the device's memory in flash. espcoredump.py reads it with the .elf of the release that crashed."
      />
      <ReadNotice read={read} name="crash dump" />
      {dump && (
        <SettingRow
          title={dump.present ? 'One crash dump is stored' : 'No crash dump is stored'}
          description={
            dump.present
              ? bytes(dump.size_bytes)
              : 'A panic stores one here, in place of any before it.'
          }
        >
          {dump.present && (
            <Actions>
              <Button busy={download.isPending} onClick={() => download.mutate()}>
                Download
              </Button>
              <Button variant="destructive" onClick={() => setEraseAsked(true)}>
                Erase
              </Button>
            </Actions>
          )}
        </SettingRow>
      )}
      <WriteConfirm
        open={eraseAsked}
        onOpenChange={setEraseAsked}
        title="Erase the crash dump?"
        description="The device keeps one dump; a later panic writes the next."
        confirmLabel="Erase"
        destructive
        failed="The crash dump is still stored."
        write={eraseCoredump}
      />
    </Card>
  );
}
