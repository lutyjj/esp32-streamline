import { Button, FormDialog, Notice, SettingRow, TextField, useToast } from 'linen';
import { useState } from 'react';
import { errorMessage } from '../../../shared/errors';
import { setTarget } from '../../lib/api';
import { BRIDGE_PORT, targetProblems, targetRequest } from '../../lib/target';
import { withRestart } from '../../state/access';
import { rememberBridgeConsole, rememberedBridgeConsole } from '../../state/bridgeConsole';
import { status } from '../../state/device';
import {
  adoptFound,
  discovery,
  findBridges,
  searchOffered,
  type TargetDraft,
} from '../../state/discovery';

/**
 * Connect a bridge: search the device's network, use a bridge it found or
 * type its address. Use fills the fields; only Save writes the target.
 */
export function TargetDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useToast();
  const target = status.value?.target;
  const current = target?.target_host ? `${target.target_host}:${target.target_port}` : '';
  const [draft, setDraft] = useState<TargetDraft>(() => ({
    entry: {
      host: target?.target_host ?? '',
      port: String(target?.target_host ? target.target_port : BRIDGE_PORT),
    },
    console: current ? rememberedBridgeConsole(current) : '',
    consoleFilled: '',
  }));
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const problems = targetProblems(draft.entry);
  const problem = (field: 'host' | 'port') =>
    tried ? problems.find((entry) => entry.field === field)?.text : undefined;
  const found = discovery.value;

  const save = async () => {
    setTried(true);
    if (problems.length > 0) return;
    setSaving(true);
    try {
      const request = targetRequest(draft.entry);
      const done = await withRestart('the bridge change', () => setTarget(request));
      if (done === null) return;
      rememberBridgeConsole(`${request.target_host}:${request.target_port}`, draft.console);
      onOpenChange(false);
    } catch (error) {
      toast.show({ text: `The bridge was not saved: ${errorMessage(error)}`, sticky: true });
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Connect a bridge"
      description="The device sends its audio to the bridge at this address. Saving restarts it."
      confirmLabel="Save"
      disabled={saving}
      onConfirm={() => void save()}
    >
      {searchOffered.value && (
        <div className="mb-4 grid gap-3">
          <div>
            <Button busy={found.phase === 'searching'} onClick={() => void findBridges()}>
              Search the network
            </Button>
          </div>
          {found.phase === 'found' && found.bridges.length > 0 && (
            <div className="rounded-card border border-border">
              {found.bridges.map((bridge) => (
                <SettingRow
                  key={`${bridge.host}:${bridge.port}`}
                  title={bridge.name}
                  description={`${bridge.host}:${bridge.port}`}
                >
                  <Button onClick={() => setDraft(adoptFound(draft, bridge))}>Use</Button>
                </SettingRow>
              ))}
            </div>
          )}
          {found.phase === 'found' && (
            <Notice
              tone="accent"
              title={
                found.bridges.length > 0
                  ? 'A found bridge is a hint: any computer on the network can answer as one.'
                  : 'No bridge answered.'
              }
              description="Compare the address before saving. A bridge behind port mapping, or on a network that blocks multicast, is reached by typing its address."
            />
          )}
          {found.phase === 'failed' && (
            <Notice
              tone="warn"
              title="The search did not finish."
              description={`${found.reason}. Type the bridge's address instead.`}
            />
          )}
        </div>
      )}
      <TextField
        label="Bridge address"
        width={96}
        autoCapitalize="none"
        spellCheck={false}
        value={draft.entry.host}
        error={problem('host')}
        onChange={(event) =>
          setDraft({ ...draft, entry: { ...draft.entry, host: event.currentTarget.value } })
        }
      />
      <TextField
        label="Port"
        width={32}
        inputMode="numeric"
        value={draft.entry.port}
        error={problem('port')}
        onChange={(event) =>
          setDraft({ ...draft, entry: { ...draft.entry, port: event.currentTarget.value } })
        }
      />
      <TextField
        label="Bridge console address"
        width={96}
        hint="Optional, such as http://192.0.2.20:8088/. The console links there to check reception."
        value={draft.console}
        onChange={(event) => setDraft({ ...draft, console: event.currentTarget.value })}
      />
    </FormDialog>
  );
}
