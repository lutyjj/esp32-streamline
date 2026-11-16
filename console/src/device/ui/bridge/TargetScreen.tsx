import { useMutation } from '@tanstack/preact-query';
import {
  Button,
  Card,
  CardBody,
  CardHead,
  Content,
  Form,
  Notice,
  SettingRow,
  TextField,
  useUnsavedChanges,
} from 'linen';
import { useState } from 'react';
import { type DiscoveredBridge, getSetTargetUrl } from '../../../generated/api';
import { errorMessage } from '../../../shared/errors';
import { fieldErrors } from '../../../shared/http';
import { navigate } from '../../../shared/navigation';
import { queryClient } from '../../../shared/queries';
import { WriteFailure } from '../../../shared/WriteFailure';
import { consoleAddressProblem } from '../../lib/consoleAddress';
import { status } from '../../state/device';
import { findBridges, searchOffered } from '../../state/discovery';
import { updateLock } from '../../state/ota';
import {
  adoptFound,
  draftChanges,
  fillsTarget,
  hostProblem,
  portProblem,
  type SavedTarget,
  savedDraft,
  saveTarget,
  TARGET_FIELDS,
  type TargetDraft,
} from '../../state/targetForm';
import { ScreenTop } from '../ScreenTop';

const TRAIL = [{ href: '/bridge', label: 'Bridge' }];

/**
 * Connect a bridge: search the device's network, use a bridge it found or
 * type its address. Use fills the fields; only Save writes the target.
 */
export function TargetScreen() {
  const known = status.value;
  return (
    <>
      <ScreenTop title="Connect a bridge" trail={TRAIL} />
      <Content>{known && <TargetForm target={known.target} />}</Content>
    </>
  );
}

/** The form, opened on the target the device last reported. */
function TargetForm({ target }: { target: SavedTarget }) {
  const [saved] = useState(() => savedDraft(target));
  const [draft, setDraft] = useState<TargetDraft>(saved);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation(
    {
      mutationFn: () => saveTarget(draft, saved),
      onSuccess: (done) => {
        setErrors({});
        if (done) navigate('/bridge');
      },
      onError: (error) => setErrors(fieldErrors(error, TARGET_FIELDS)),
    },
    queryClient,
  );
  const changes = draftChanges(draft, saved);
  const unsaved = changes.target || changes.console;
  // A new target restarts the device, which waits while an update runs.
  const held = changes.target ? updateLock(getSetTargetUrl()) : null;
  useUnsavedChanges(unsaved, { name: 'the bridge', pending: save.isPending });

  return (
    <div className="grid gap-4">
      {searchOffered.value && (
        <FoundBridges draft={draft} onUse={(bridge) => setDraft(adoptFound(draft, bridge))} />
      )}
      <Card>
        <CardHead
          title="Address"
          description={
            changes.target
              ? 'The device restarts to send its audio to this bridge.'
              : 'The bridge the device sends its audio to.'
          }
        />
        <CardBody>
          <Form errors={errors} onSubmit={() => save.mutateAsync().catch(() => undefined)}>
            <TextField
              label="Bridge address"
              name="target_host"
              width={96}
              autoCapitalize="none"
              spellCheck={false}
              value={draft.entry.host}
              readOnly={save.isPending}
              validate={(value) => hostProblem(String(value ?? ''))}
              onChange={(event) =>
                setDraft({ ...draft, entry: { ...draft.entry, host: event.currentTarget.value } })
              }
            />
            <TextField
              label="Port"
              name="target_port"
              width={32}
              inputMode="numeric"
              value={draft.entry.port}
              readOnly={save.isPending}
              validate={(value) => portProblem(String(value ?? ''))}
              onChange={(event) =>
                setDraft({ ...draft, entry: { ...draft.entry, port: event.currentTarget.value } })
              }
            />
            <TextField
              label="Bridge console address"
              width={96}
              autoCapitalize="none"
              spellCheck={false}
              hint="Optional, such as http://192.0.2.20:8088/. Bridge links straight to this device's source there."
              value={draft.console}
              readOnly={save.isPending}
              validate={(value) => consoleAddressProblem(String(value ?? ''))}
              onChange={(event) => setDraft({ ...draft, console: event.currentTarget.value })}
            />
            {save.error && Object.keys(errors).length === 0 && (
              <WriteFailure
                className="mt-3"
                failed="The device did not save the bridge."
                error={save.error}
              />
            )}
            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              {held && <p className="mr-auto text-sm text-text-secondary">{held}</p>}
              <Button
                type="submit"
                variant="primary"
                busy={save.isPending}
                disabled={!unsaved || held !== null}
              >
                Save
              </Button>
            </div>
          </Form>
        </CardBody>
      </Card>
    </div>
  );
}

/** The search, and what it found in the page's flow, each offered to fill the form. */
function FoundBridges({
  draft,
  onUse,
}: {
  draft: TargetDraft;
  onUse: (bridge: DiscoveredBridge) => void;
}) {
  const search = useMutation({ mutationFn: findBridges }, queryClient);
  const found = search.data;
  return (
    <Card>
      <CardHead
        title="Find a bridge"
        description="The device asks its network for bridges for about three seconds."
      >
        <Button busy={search.isPending} onClick={() => search.mutate()}>
          Search the network
        </Button>
      </CardHead>
      {found && found.length > 0 && (
        // biome-ignore lint/a11y/useSemanticElements: SettingRow is a div with the listitem role, which a <ul> may not hold.
        <div role="list" aria-label="Bridges found">
          {found.map((bridge) => (
            <SettingRow
              key={`${bridge.host}:${bridge.port}`}
              role="listitem"
              title={bridge.name}
              description={`${bridge.host}:${bridge.port}`}
            >
              <Button
                disabled={fillsTarget(bridge, draft.entry.host, draft.entry.port)}
                onClick={() => onUse(bridge)}
              >
                Use
              </Button>
            </SettingRow>
          ))}
        </div>
      )}
      {(found || search.isError) && (
        <CardBody>
          {found ? (
            <Notice
              tone="accent"
              title={
                found.length > 0
                  ? 'A found bridge is a hint: any computer on the network can answer as one.'
                  : 'No bridge answered.'
              }
              description="Compare the address before saving. A bridge behind port mapping, or on a network that blocks multicast, is reached by typing its address."
            />
          ) : (
            <Notice
              tone="warn"
              title="The search did not finish."
              description={`${errorMessage(search.error)}. Type the bridge's address instead.`}
            />
          )}
        </CardBody>
      )}
    </Card>
  );
}
