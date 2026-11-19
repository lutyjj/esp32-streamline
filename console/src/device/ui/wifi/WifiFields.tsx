import { Checkbox, Notice, TextField } from 'linen';
import { passwordProblem, ssidProblem, type WifiEntry } from '../../lib/wifi';

/**
 * The network the device joins: its name, its password, and the explicit
 * choice of an open network, which names what it exposes. Each field checks
 * its value against the contract when the form is submitted; the form's
 * `errors` carry what the device refused.
 */
export function WifiFields({
  entry,
  onChange,
  storedPassword,
  disabled = false,
}: {
  entry: WifiEntry;
  onChange: (entry: WifiEntry) => void;
  /** A protected network is saved, so a blank password keeps it. */
  storedPassword: boolean;
  disabled?: boolean;
}) {
  return (
    <>
      <TextField
        label="Network name"
        name="ssid"
        width={96}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        value={entry.ssid}
        readOnly={disabled}
        validate={(value) => ssidProblem(String(value ?? ''))}
        onChange={(event) => onChange({ ...entry, ssid: event.currentTarget.value })}
      />
      {!entry.open && (
        <TextField
          label="Password"
          name="password"
          width={96}
          type="password"
          autoComplete="off"
          hint={storedPassword ? 'Leave it blank to keep the saved password.' : undefined}
          value={entry.password}
          readOnly={disabled}
          validate={(value) => passwordProblem(String(value ?? ''))}
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
          tone="warn"
          title="Anyone in range can join an open network."
          description="They can read what the device sends and change the console it serves. Choose it only for a network you trust."
        />
      )}
    </>
  );
}
