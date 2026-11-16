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
import { errorMessage } from '../../../shared/errors';
import { navigate } from '../../../shared/navigation';
import { type DiscoveredBridge, getSetTargetUrl } from '../../lib/api';
import { targetProblems } from '../../lib/target';
import { status } from '../../state/device';
import { discovery, findBridges, searchOffered } from '../../state/discovery';
import { updateLock } from '../../state/ota';
import {
  adoptFound,
  draftChanges,
  fillsTarget,
  type SavedTarget,
  savedDraft,
  saveTarget,
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
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState('');
  const changes = draftChanges(draft, saved);
  const unsaved = changes.target || changes.console;
  // A new target restarts the device, which waits while an update runs.
  const held = changes.target ? updateLock(getSetTargetUrl()) : null;
  useUnsavedChanges(unsaved, { name: 'the bridge', pending: saving });
  const problems = targetProblems(draft.entry);
  const problem = (field: 'host' | 'port') =>
    tried ? problems.find((entry) => entry.field === field)?.text : undefined;

  const save = async () => {
    setTried(true);
    setFailure('');
    if (problems.length > 0) return;
    setSaving(true);
    try {
      if (await saveTarget(draft, saved)) navigate('/bridge');
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

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
          <Form onSubmit={save}>
            <TextField
              label="Bridge address"
              width={96}
              autoCapitalize="none"
              spellCheck={false}
              value={draft.entry.host}
              readOnly={saving}
              error={problem('host')}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  entry: { ...draft.entry, host: event.currentTarget.value },
                })
              }
            />
            <TextField
              label="Port"
              width={32}
              inputMode="numeric"
              value={draft.entry.port}
              readOnly={saving}
              error={problem('port')}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  entry: { ...draft.entry, port: event.currentTarget.value },
                })
              }
            />
            <TextField
              label="Bridge console address"
              width={96}
              autoCapitalize="none"
              spellCheck={false}
              hint="Optional, such as http://192.0.2.20:8088/. Bridge links straight to this device's source there."
              value={draft.console}
              readOnly={saving}
              onChange={(event) => setDraft({ ...draft, console: event.currentTarget.value })}
            />
            {failure !== '' && (
              <Notice
                className="mt-3"
                tone="danger"
                title="The device did not save the bridge."
                description={failure}
              />
            )}
            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              {held && <p className="mr-auto text-sm text-text-secondary">{held}</p>}
              <Button
                type="submit"
                variant="primary"
                busy={saving}
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
  const found = discovery.value;
  return (
    <Card>
      <CardHead
        title="Find a bridge"
        description="The device asks its network for bridges for about three seconds."
      >
        <Button busy={found.phase === 'searching'} onClick={() => void findBridges()}>
          Search the network
        </Button>
      </CardHead>
      {found.phase === 'found' && found.bridges.length > 0 && (
        // biome-ignore lint/a11y/useSemanticElements: SettingRow is a div with the listitem role, which a <ul> may not hold.
        <div role="list" aria-label="Bridges found">
          {found.bridges.map((bridge) => (
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
      {(found.phase === 'found' || found.phase === 'failed') && (
        <CardBody>
          {found.phase === 'found' ? (
            <Notice
              tone="accent"
              title={
                found.bridges.length > 0
                  ? 'A found bridge is a hint: any computer on the network can answer as one.'
                  : 'No bridge answered.'
              }
              description="Compare the address before saving. A bridge behind port mapping, or on a network that blocks multicast, is reached by typing its address."
            />
          ) : (
            <Notice
              tone="warn"
              title="The search did not finish."
              description={`${found.reason}. Type the bridge's address instead.`}
            />
          )}
        </CardBody>
      )}
    </Card>
  );
}
