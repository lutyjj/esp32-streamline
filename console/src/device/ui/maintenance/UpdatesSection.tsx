import { useMutation, useQuery } from '@tanstack/preact-query';
import {
  Button,
  Card,
  CardBody,
  CardHead,
  Fact,
  Facts,
  Form,
  type FormErrors,
  Notice,
  Progress,
  SegmentedControl,
  SettingRow,
  TextField,
  useToast,
} from 'linen';
import { useState } from 'react';
import {
  type AutoUpdateScheduleRequest,
  getOtaRollbackUrl,
  type StatusResponse,
} from '../../../generated/api';
import { fieldErrors } from '../../../shared/http';
import { queryClient } from '../../../shared/queries';
import { ReadNotice } from '../../../shared/ReadNotice';
import { WriteConfirm } from '../../../shared/WriteConfirm';
import { WriteFailure } from '../../../shared/WriteFailure';
import { writeFailure } from '../../../shared/writeFailure';
import { status } from '../../state/device';
import {
  checkForUpdate,
  INSTALL_RESULT_WORDS,
  imageDigestProblem,
  imageUrlProblem,
  install,
  installProgress,
  rollBack,
  scheduleUpdates,
  updateLock,
} from '../../state/ota';
import { settingsQuery } from '../../state/queries';

const SCHEDULES: { value: AutoUpdateScheduleRequest; label: string }[] = [
  { value: 'disabled', label: 'Off' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
];

/** The firmware the device runs, its updates, and the way back. */
export function UpdatesSection() {
  const known = status.value;
  if (!known) return null;
  return (
    <div className="grid gap-4">
      <FirmwareCard known={known} />
      <CustomImageCard signingKey={known.ota.signing_key_sha256} busy={known.ota.busy} />
    </div>
  );
}

function FirmwareCard({ known }: { known: StatusResponse }) {
  const toast = useToast();
  const [rollbackAsked, setRollbackAsked] = useState(false);
  const { ota } = known;
  const failed = (what: string) => (error: unknown) => {
    const words = writeFailure(error, what, 'device');
    toast.show({ text: `${words.title} ${words.description}`, sticky: true });
  };
  const check = useMutation(
    { mutationFn: checkForUpdate, onError: failed('The device did not start the check.') },
    queryClient,
  );
  const latest = useMutation(
    { mutationFn: () => install(), onError: failed('The device did not start the update.') },
    queryClient,
  );
  const progress = installProgress(known);
  const lastInstall = INSTALL_RESULT_WORDS[ota.last_result];
  // A rollback restarts the device, which waits while an update runs.
  const held = updateLock(getOtaRollbackUrl());
  return (
    <Card>
      <CardHead
        title="Firmware"
        description="Checks and installs pause the audio, which resumes once they finish."
      >
        <Button
          busy={check.isPending || ota.phase === 'checking'}
          disabled={ota.busy}
          onClick={() => check.mutate()}
        >
          Check for updates
        </Button>
      </CardHead>
      <CardBody className="grid gap-4">
        <Facts>
          <Fact name="Running" mono>
            {known.firmware_version}
            {known.firmware_variant !== 'standard' && ` (${known.firmware_variant})`}
          </Fact>
          {ota.latest_version && (
            <Fact name="Latest release" mono>
              {ota.latest_version}
            </Fact>
          )}
          {lastInstall && <Fact name="Last install">{lastInstall}</Fact>}
        </Facts>
        {ota.last_result !== 'installed' && lastInstall && known.diagnostics.last_ota && (
          <p className="text-sm text-text-secondary">{known.diagnostics.last_ota}</p>
        )}
        {ota.busy && ota.phase !== 'checking' && (
          <Progress label={progress.words} value={progress.fraction ?? undefined} />
        )}
        {ota.phase === 'update-available' && !ota.busy && (
          <Notice
            title={`Version ${ota.latest_version} is available.`}
            description="Installing restarts the device into it. A version that does not start goes back to this one."
            action={
              <Button variant="primary" busy={latest.isPending} onClick={() => latest.mutate()}>
                Install {ota.latest_version}
              </Button>
            }
          />
        )}
        {ota.phase === 'up-to-date' && (
          <Notice tone="positive" title="This is the latest release." />
        )}
        {ota.phase === 'failed' && (
          <Notice
            tone="danger"
            title="The last check or install failed."
            description={ota.message}
          />
        )}
      </CardBody>
      <ScheduleRow />
      {ota.rollback_available && (
        <SettingRow
          title={`Previous image ${ota.rollback_version}`}
          description={held ?? 'Still in the other slot, so the device can go back to it.'}
        >
          <Button disabled={held !== null} onClick={() => setRollbackAsked(true)}>
            Roll back
          </Button>
        </SettingRow>
      )}
      <WriteConfirm
        open={rollbackAsked}
        onOpenChange={setRollbackAsked}
        title={`Go back to ${ota.rollback_version}?`}
        description="The device restarts into the previous image, and the audio stops until it is back."
        confirmLabel="Roll back"
        failed="The device stayed on this firmware."
        write={rollBack}
      />
    </Card>
  );
}

function ScheduleRow() {
  const toast = useToast();
  const settings = useQuery(settingsQuery, queryClient);
  const schedule = useMutation(
    {
      mutationFn: scheduleUpdates,
      onError: (error) => {
        const words = writeFailure(error, 'The schedule stayed as it was.', 'device');
        toast.show({ text: `${words.title} ${words.description}`, sticky: true });
      },
    },
    queryClient,
  );
  if (!settings.data)
    return settings.isError ? (
      <CardBody>
        <ReadNotice read={settings} name="device settings" />
      </CardBody>
    ) : null;
  return (
    <SettingRow
      title="Automatic updates"
      description="Ten minutes after it starts, the device checks on this schedule and installs a newer release once the audio is idle."
    >
      <SegmentedControl
        label="Automatic updates"
        value={settings.data.auto_update_schedule}
        options={SCHEDULES}
        disabled={schedule.isPending}
        onValueChange={(value) => schedule.mutate(value)}
      />
    </SettingRow>
  );
}

/** A developer's image, pinned by its digest and signed with the key this firmware trusts. */
function CustomImageCard({ signingKey, busy }: { signingKey: string; busy: boolean }) {
  const [image, setImage] = useState({ url: '', sha256: '' });
  const [errors, setErrors] = useState<FormErrors>({});
  const start = useMutation(
    {
      mutationFn: () => install({ url: image.url.trim(), sha256: image.sha256.trim() }),
      onSuccess: () => setErrors({}),
      onError: (error) => setErrors(fieldErrors(error, ['url', 'sha256'])),
    },
    queryClient,
  );
  return (
    <Card>
      <CardHead
        title="Install a custom image"
        description="For development: an image signed with the key this firmware trusts, pinned by its SHA-256. A different key needs a serial flash."
      />
      <CardBody className="grid gap-4">
        <Facts>
          <Fact name="Signing key SHA-256" mono copy={{ value: signingKey, label: 'Signing key' }}>
            {signingKey || 'Unknown'}
          </Fact>
        </Facts>
        <Form errors={errors} onSubmit={() => start.mutateAsync().catch(() => undefined)}>
          <TextField
            label="Image address"
            name="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="http://192.0.2.5:8000/streamline-dev-ota.bin"
            value={image.url}
            readOnly={start.isPending}
            validate={(value) => imageUrlProblem(String(value ?? ''))}
            onChange={(event) => setImage({ ...image, url: event.currentTarget.value })}
          />
          <TextField
            label="SHA-256"
            name="sha256"
            autoComplete="off"
            spellCheck={false}
            value={image.sha256}
            readOnly={start.isPending}
            validate={(value) => imageDigestProblem(String(value ?? ''))}
            onChange={(event) => setImage({ ...image, sha256: event.currentTarget.value })}
          />
          {start.error && Object.keys(errors).length === 0 && (
            <WriteFailure failed="The device did not start the install." error={start.error} />
          )}
          <div className="mt-4 flex justify-end">
            <Button type="submit" variant="primary" busy={start.isPending} disabled={busy}>
              Install
            </Button>
          </div>
        </Form>
      </CardBody>
    </Card>
  );
}
