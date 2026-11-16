import { Checkbox, Notice, TextField } from 'linen';
import type { WifiEntry, WifiProblem } from '../../lib/wifi';

/**
 * The network the device joins: its name, its password, and the explicit
 * choice of an open network, which names what it exposes. Problems show
 * once the owner has tried to save.
 */
export function WifiFields({
  entry,
  onChange,
  problems,
  storedPassword,
  disabled = false,
}: {
  entry: WifiEntry;
  onChange: (entry: WifiEntry) => void;
  problems: readonly WifiProblem[];
  /** A protected network is saved, so a blank password keeps it. */
  storedPassword: boolean;
  disabled?: boolean;
}) {
  const problem = (field: WifiProblem['field']) =>
    problems.find((entry) => entry.field === field)?.text;
  return (
    <>
      <TextField
        label="Network name"
        width={96}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        value={entry.ssid}
        readOnly={disabled}
        error={problem('ssid')}
        onChange={(event) => onChange({ ...entry, ssid: event.currentTarget.value })}
      />
      {!entry.open && (
        <TextField
          label="Password"
          width={96}
          type="password"
          autoComplete="off"
          hint={storedPassword ? 'Leave it blank to keep the saved password.' : undefined}
          value={entry.password}
          readOnly={disabled}
          error={problem('password')}
          onChange={(event) => onChange({ ...entry, password: event.currentTarget.value })}
        />
      )}
      <Checkbox
        checked={entry.open}
        disabled={disabled}
        onCheckedChange={(open) => onChange({ ...entry, open, password: '' })}
      >
        This network has no password
      </Checkbox>
      {entry.open && (
        <Notice
          className="mt-3"
          tone="warn"
          title="Anyone in range can join an open network."
          description="They can read what the device sends and change the console it serves. Choose it only for a network you trust."
        />
      )}
    </>
  );
}
