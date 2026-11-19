import { useMutation } from '@tanstack/preact-query';
import {
  Actions,
  Button,
  Card,
  CardBody,
  CardHead,
  Fact,
  Facts,
  Form,
  Nothing,
  SettingRow,
  Status,
  TextField,
  useToast,
  useUnsavedChanges,
} from 'linen';
import { useState } from 'react';
import type { BridgeStatus } from '../../../generated/bridge';
import { FIELD_WIDTH } from '../../../shared/fieldWidth';
import { fieldErrors } from '../../../shared/http';
import { queryClient } from '../../../shared/queries';
import { WriteConfirm } from '../../../shared/WriteConfirm';
import { WriteFailure } from '../../../shared/WriteFailure';
import { TRANSPORT_STATE_OPTION } from '../../lib/deployment';
import { useReadOnly } from '../../state/access';
import {
  enrollKey,
  keyIdProblem,
  pskProblem,
  removeKey,
  setListenerMode,
} from '../../state/security';
import { NeedsToken } from '../NeedsToken';

/** The listener mode every device meets, and the device credentials it accepts. */
export function SecuritySection({ known }: { known: BridgeStatus }) {
  const readOnly = useReadOnly();
  return (
    <>
      <Listener known={known} readOnly={readOnly} />
      {known.transport.configurable && (
        <>
          <Credentials known={known} readOnly={readOnly} />
          {!readOnly && <Enroll enrolled={known.transport.key_ids} />}
        </>
      )}
    </>
  );
}

function Listener({ known, readOnly }: { known: BridgeStatus; readOnly: boolean }) {
  const [asking, setAsking] = useState(false);
  const { mode, port, configurable, auth_successes, auth_failures } = known.transport;
  const encrypted = mode === 'tls-psk';
  return (
    <Card>
      <CardHead
        title="Listener"
        aside={
          <Status tone={encrypted ? 'positive' : 'neutral'}>
            {encrypted ? 'Encryption required' : 'Cleartext'}
          </Status>
        }
        description={
          encrypted
            ? `Devices send audio on port ${port} over TLS 1.3, each with a credential enrolled here.`
            : `Devices send audio on port ${port} in the clear. Requiring encryption applies to every device at once.`
        }
      >
        {configurable && !readOnly && (
          <Button onClick={() => setAsking(true)}>
            {encrypted ? 'Return to cleartext' : 'Require encryption'}
          </Button>
        )}
      </CardHead>
      <CardBody>
        {configurable ? (
          <>
            {readOnly && <NeedsToken change="Changing audio security" />}
            <Facts>
              <Fact name="Accepted handshakes">{auth_successes}</Fact>
              <Fact name="Refused handshakes">{auth_failures}</Fact>
            </Facts>
          </>
        ) : (
          <p className="text-sm text-text-secondary">
            Audio security needs a place to keep its state. Set {TRANSPORT_STATE_OPTION} for a
            container, then restart the bridge; the Home Assistant app sets it.
          </p>
        )}
      </CardBody>
      <WriteConfirm
        open={asking}
        onOpenChange={setAsking}
        title={encrypted ? 'Return to cleartext?' : 'Require encryption?'}
        description={
          encrypted
            ? 'Devices sending encrypted audio stop until each turns encryption off in its own console.'
            : 'Devices sending in the clear stop until each turns encryption on with a credential enrolled here.'
        }
        confirmLabel={encrypted ? 'Return to cleartext' : 'Require encryption'}
        failed="The listener kept its mode."
        write={() => setListenerMode(encrypted ? 'cleartext' : 'tls-psk')}
      />
    </Card>
  );
}

function Credentials({ known, readOnly }: { known: BridgeStatus; readOnly: boolean }) {
  const [removing, setRemoving] = useState<string | null>(null);
  const ids = known.transport.key_ids;
  return (
    <Card>
      <CardHead
        title="Device credentials"
        description="Each lets one device send encrypted audio, and names its source while it does."
      />
      {ids.length === 0 ? (
        <Nothing>
          {readOnly
            ? 'No credential enrolled. A device makes its credential in its own console, under Bridge, Encryption.'
            : 'No credential enrolled. A device makes its credential in its own console, under Bridge, Encryption, and shows it once to enroll here.'}
        </Nothing>
      ) : (
        // biome-ignore lint/a11y/useSemanticElements: SettingRow is a div with the listitem role, which a <ul> may not hold.
        <div role="list" aria-label="Device credentials">
          {ids.map((id) => (
            <SettingRow
              key={id}
              role="listitem"
              title={<span className="font-mono">{id}</span>}
              description={
                known.sources[id]?.lifecycle.state === 'connected'
                  ? 'Connected now'
                  : 'Not connected'
              }
            >
              {!readOnly && (
                <Button variant="destructive" onClick={() => setRemoving(id)}>
                  Remove
                </Button>
              )}
            </SettingRow>
          ))}
        </div>
      )}
      <WriteConfirm
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title="Remove this credential?"
        description={`The device using ${removing ?? ''} loses its encrypted connection and cannot connect with it again. Enroll a new one to bring its audio back.`}
        confirmLabel="Remove"
        destructive
        failed="The credential stays."
        write={() => (removing ? removeKey(removing) : Promise.resolve(null))}
      />
    </Card>
  );
}

function Enroll({ enrolled }: { enrolled: readonly string[] }) {
  const [keyId, setKeyId] = useState('');
  const [psk, setPsk] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [replacing, setReplacing] = useState(false);
  const toast = useToast();
  const id = keyId.trim();
  const add = useMutation(
    {
      mutationFn: () => enrollKey(id, psk.trim()),
      onSuccess: (done) => {
        setErrors({});
        if (!done) return;
        setKeyId('');
        setPsk('');
        toast.show({ text: `${id} is enrolled.` });
      },
      onError: (error) => setErrors(fieldErrors(error, ['key_id', 'psk'])),
    },
    queryClient,
  );
  useUnsavedChanges(keyId !== '' || psk !== '', { name: 'the credential', pending: add.isPending });
  return (
    <Card>
      <CardHead
        title="Enroll a credential"
        description="Copy the ID and key the device console shows once, under Bridge, Encryption. Enrolling works in either mode, so do it before requiring encryption."
      />
      <Form
        errors={errors}
        onSubmit={() =>
          enrolled.includes(id) ? setReplacing(true) : add.mutateAsync().catch(() => undefined)
        }
      >
        <CardBody>
          <TextField
            label="Credential ID"
            name="key_id"
            width={FIELD_WIDTH}
            autoComplete="off"
            spellCheck={false}
            value={keyId}
            validate={(value) => keyIdProblem(String(value ?? '').trim())}
            onChange={(event) => setKeyId(event.currentTarget.value)}
          />
          <TextField
            label="Key"
            name="psk"
            autoComplete="off"
            spellCheck={false}
            value={psk}
            validate={(value) => pskProblem(String(value ?? '').trim())}
            onChange={(event) => setPsk(event.currentTarget.value)}
          />
          {add.error && Object.keys(errors).length === 0 && (
            <WriteFailure failed="The credential was not enrolled." error={add.error} />
          )}
          <Actions className="justify-end">
            <Button type="submit" variant="primary" busy={add.isPending} disabled={!id || !psk}>
              Enroll
            </Button>
          </Actions>
        </CardBody>
      </Form>
      <WriteConfirm
        open={replacing}
        onOpenChange={setReplacing}
        title="Replace this credential?"
        description={`${id} is enrolled already. Its new key closes the device's encrypted connection until the device uses that key too.`}
        confirmLabel="Replace"
        failed="The credential was not replaced."
        write={() => add.mutateAsync()}
      />
    </Card>
  );
}
