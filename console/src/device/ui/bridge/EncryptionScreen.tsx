import { useMutation, useQuery } from '@tanstack/preact-query';
import {
  Button,
  Card,
  CardBody,
  CardHead,
  Content,
  Fact,
  Facts,
  LINK_CLASS,
  Notice,
  SettingRow,
  ShownOnce,
  Steps,
} from 'linen';
import { useState } from 'react';
import {
  getActivateTransportKeyUrl,
  getRollbackTransportKeyUrl,
  getSetTransportModeUrl,
  type TransportStatus,
} from '../../../generated/api';
import { queryClient } from '../../../shared/queries';
import { ReadNotice } from '../../../shared/ReadNotice';
import { WriteConfirm } from '../../../shared/WriteConfirm';
import { WriteFailure } from '../../../shared/WriteFailure';
import { bridgeSecurityLink } from '../../lib/consoleAddress';
import { rememberedBridgeConsole } from '../../state/bridgeConsole';
import { status } from '../../state/device';
import { updateLock } from '../../state/ota';
import { settingsQuery } from '../../state/queries';
import {
  activateKey,
  discardKey,
  encryptionStep,
  keyActions,
  makeKey,
  type RevealedKey,
  retireKey,
  returnToCleartext,
  revealed,
  rollBackKey,
  verifyKey,
} from '../../state/transport';
import { ScreenTop } from '../ScreenTop';

const TRAIL = [{ href: '/bridge', label: 'Bridge' }];

const STEPS = [
  { id: 'credential', label: 'Make a credential' },
  { id: 'bridge', label: 'Add it to the bridge' },
  { id: 'activate', label: 'Turn it on' },
] as const;

/**
 * Encrypted audio, which takes both consoles: the device makes a credential,
 * the bridge console enrolls it and requires encryption, and the device
 * verifies it and restarts into it. The guide resumes where the key stands.
 */
export function EncryptionScreen() {
  const known = status.value;
  const settings = useQuery(settingsQuery, queryClient);
  const transport = settings.data?.transport;
  const target = known ? `${known.target.target_host}:${known.target.target_port}` : '';
  return (
    <>
      <ScreenTop title="Encryption" trail={TRAIL} />
      <Content>
        <div className="grid gap-4">
          <ReadNotice read={settings} name="device settings" />
          {transport &&
            (transport.mode === 'tls-psk' && !transport.pending_key_id ? (
              <EncryptionOn transport={transport} />
            ) : (
              <Guide transport={transport} target={target} />
            ))}
          {transport &&
            (transport.mode === 'tls-psk' ||
              transport.pending_key_id ||
              transport.rollback_key_id) && <Advanced transport={transport} />}
        </div>
      </Content>
    </>
  );
}

function Guide({ transport, target }: { transport: TransportStatus; target: string }) {
  const step = encryptionStep(transport);
  const actions = keyActions(transport);
  // Replacing a credential leaves the bridge encrypted throughout.
  const replacing = transport.mode === 'tls-psk';
  const shown = revealed.value;
  const [discardAsked, setDiscardAsked] = useState(false);
  const make = useMutation({ mutationFn: () => makeKey() }, queryClient);
  const verify = useMutation({ mutationFn: verifyKey }, queryClient);
  const activate = useMutation({ mutationFn: activateKey }, queryClient);
  // Turning it on restarts the device, which waits while an update runs.
  const held = updateLock(getActivateTransportKeyUrl());
  const bridgeConsole = rememberedBridgeConsole(target);
  const security = bridgeConsole ? bridgeSecurityLink(bridgeConsole) : undefined;
  return (
    <Card>
      <CardHead
        title={replacing ? 'Replace the credential' : 'Set up encryption'}
        description="The device and the bridge share a credential, so the bridge knows which device sends and nobody else reads the audio. Both consoles take part."
      />
      <CardBody className="grid gap-4">
        <Steps label="Encryption" steps={STEPS} current={step} />
        {step === 'credential' && (
          <>
            {actions.stage ? (
              <p className="text-sm text-text-secondary">
                The device makes a credential and shows it once. Audio keeps streaming in the clear
                until the bridge requires encryption.
              </p>
            ) : (
              <Notice
                title="The device still keeps its previous credential."
                description="It holds two at most, so retire that one under Advanced security first."
              />
            )}
            {make.error && (
              <WriteFailure failed="The device made no credential." error={make.error} />
            )}
          </>
        )}
        {step === 'bridge' && (
          <>
            {shown ? (
              <Credential shown={shown} />
            ) : (
              <Notice
                tone="warn"
                title="This credential was shown on an earlier visit."
                description="If the bridge has it, verify. If it is lost, discard it and make another."
              />
            )}
            <ol className="grid list-decimal gap-2 pl-5 text-sm">
              <li>
                Open the bridge console's Settings → Audio security
                {security && (
                  <>
                    {' '}
                    (
                    <a className={LINK_CLASS} href={security} target="_blank" rel="noreferrer">
                      open it
                    </a>
                    )
                  </>
                )}{' '}
                and unlock it with the bridge API token.
              </li>
              <li>Add the key id and the PSK under Device credentials.</li>
              {!replacing && (
                <li>Choose Require encryption. Audio pauses until this device follows.</li>
              )}
              <li>Come back and verify: the device makes a real connection to the bridge.</li>
            </ol>
            {shown?.recovery && (
              <Notice
                tone="warn"
                title="The device starts in the clear from its next start."
                description="To hear audio before this credential is on, switch the bridge to cleartext and restart the device; then require encryption again and verify."
              />
            )}
            {verify.error && (
              <WriteFailure
                failed="The bridge did not accept the credential."
                error={verify.error}
              />
            )}
          </>
        )}
        {step === 'activate' && (
          <>
            <Notice
              tone="positive"
              title="The bridge accepted the credential."
              description="Turning it on restarts the device into encrypted audio, which pauses for a few seconds."
            />
            {activate.error && (
              <WriteFailure failed="Encryption stayed off." error={activate.error} />
            )}
          </>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {held && step === 'activate' && (
            <p className="mr-auto text-sm text-text-secondary">{held}</p>
          )}
          {step !== 'credential' && (
            <Button variant="destructive" onClick={() => setDiscardAsked(true)}>
              Discard
            </Button>
          )}
          {step === 'credential' && (
            <Button
              variant="primary"
              busy={make.isPending}
              disabled={!actions.stage}
              onClick={() => make.mutate()}
            >
              Make a credential
            </Button>
          )}
          {step === 'bridge' && (
            <Button variant="primary" busy={verify.isPending} onClick={() => verify.mutate()}>
              Verify with the bridge
            </Button>
          )}
          {step === 'activate' && (
            <Button
              variant="primary"
              busy={activate.isPending}
              disabled={held !== null}
              onClick={() => activate.mutate()}
            >
              Turn on encryption
            </Button>
          )}
        </div>
      </CardBody>
      <WriteConfirm
        open={discardAsked}
        onOpenChange={setDiscardAsked}
        title="Discard this credential?"
        description="The device stays as it is. If the bridge already requires encryption, switch it back in its console, and remove the credential there unless another device uses it."
        confirmLabel="Discard"
        destructive
        failed="The device kept the credential."
        write={discardKey}
      />
    </Card>
  );
}

/** The key id and the PSK, which the bridge needs both of. */
function Credential({ shown }: { shown: RevealedKey }) {
  return (
    <div className="grid gap-3">
      <Facts>
        <Fact name="Key id" mono copy={{ value: shown.key_id, label: 'Key id' }}>
          {shown.key_id}
        </Fact>
      </Facts>
      <ShownOnce
        what="PSK"
        label="PSK"
        secret={shown.psk}
        copyLabel="Copy PSK"
        lost="No screen shows it again; a lost one is replaced under Advanced security."
      >
        Give the bridge both, now.
      </ShownOnce>
    </div>
  );
}

function EncryptionOn({ transport }: { transport: TransportStatus }) {
  return (
    <Card>
      <CardHead
        title="Encryption is on"
        description="The bridge knows this device by its credential, and the audio crosses the network encrypted. Nothing needs doing routinely."
      />
      <CardBody>
        <Facts>
          <Fact name="Credential" mono>
            {transport.active_key_id}
          </Fact>
          {transport.rollback_key_id && (
            <Fact name="Previous credential" mono>
              {transport.rollback_key_id}
            </Fact>
          )}
        </Facts>
      </CardBody>
    </Card>
  );
}

type Asked = 'rollback' | 'retire' | 'recover' | 'cleartext';

/** Replacement, the way back to the previous credential, recovery and cleartext. */
function Advanced({ transport }: { transport: TransportStatus }) {
  const [asked, setAsked] = useState<Asked | null>(null);
  const replace = useMutation({ mutationFn: () => makeKey() }, queryClient);
  const actions = keyActions(transport);
  const encrypted = transport.mode === 'tls-psk';
  const rollbackHeld = updateLock(getRollbackTransportKeyUrl());
  const closed = (open: boolean) => {
    if (!open) setAsked(null);
  };
  return (
    <Card>
      <CardHead title="Advanced security" />
      {encrypted && !transport.pending_key_id && (
        <SettingRow
          title="Replace the credential"
          description={
            actions.stage
              ? 'After it may have leaked, or the device changes hands. The bridge stays encrypted while the new one is added.'
              : 'Go back to the previous credential or retire it first.'
          }
        >
          <Button
            busy={replace.isPending}
            disabled={!actions.stage}
            onClick={() => replace.mutate()}
          >
            Replace
          </Button>
        </SettingRow>
      )}
      {replace.error && (
        <CardBody className="pt-0">
          <WriteFailure failed="The device made no credential." error={replace.error} />
        </CardBody>
      )}
      {actions.retire && (
        <SettingRow
          title="Previous credential"
          description={
            encrypted
              ? (rollbackHeld ??
                'Kept while the new one proves itself. Retire it on both sides once audio has survived restarts.')
              : 'Kept from encrypted audio. Retire it on both sides before making another.'
          }
        >
          <div className="flex flex-wrap gap-2">
            {/* In the clear, going back only swaps the two keys. */}
            {encrypted && (
              <Button disabled={rollbackHeld !== null} onClick={() => setAsked('rollback')}>
                Go back to it
              </Button>
            )}
            <Button onClick={() => setAsked('retire')}>Retire</Button>
          </div>
        </SettingRow>
      )}
      <SettingRow
        title="Lost credential"
        description="When the PSK is lost: the device makes a replacement, shows it once, and starts in the clear until it is on."
      >
        <Button variant="destructive" onClick={() => setAsked('recover')}>
          Replace lost credential
        </Button>
      </SettingRow>
      {encrypted && !transport.pending_key_id && (
        <SettingRow
          title="Cleartext"
          description={
            updateLock(getSetTransportModeUrl()) ??
            'Switch the bridge to cleartext first; the device then restarts in the clear.'
          }
        >
          <Button
            disabled={updateLock(getSetTransportModeUrl()) !== null}
            onClick={() => setAsked('cleartext')}
          >
            Switch to cleartext
          </Button>
        </SettingRow>
      )}
      <WriteConfirm
        open={asked === 'rollback'}
        onOpenChange={closed}
        title="Go back to the previous credential?"
        description="The device restarts with it, and the bridge must still hold it."
        confirmLabel="Go back"
        failed="The device kept its credential."
        write={rollBackKey}
      />
      <WriteConfirm
        open={asked === 'retire'}
        onOpenChange={closed}
        title="Retire the previous credential?"
        description="The device forgets it for good. Delete it in the bridge console too."
        confirmLabel="Retire"
        destructive
        failed="The device kept the previous credential."
        write={retireKey}
      />
      <WriteConfirm
        open={asked === 'recover'}
        onOpenChange={closed}
        title="Replace the lost credential?"
        description="The device makes a new credential and shows it once, and starts in the clear until the new one is on. Audio pauses while the bridge requires encryption."
        confirmLabel="Replace"
        destructive
        failed="The device kept its credentials."
        write={() => makeKey(true)}
      />
      <WriteConfirm
        open={asked === 'cleartext'}
        onOpenChange={closed}
        title="Switch to cleartext?"
        description="The device restarts and sends audio unencrypted. Switch the bridge first, or the two stop hearing each other."
        confirmLabel="Switch"
        destructive
        failed="The device stayed encrypted."
        write={() => returnToCleartext(transport)}
      />
    </Card>
  );
}
