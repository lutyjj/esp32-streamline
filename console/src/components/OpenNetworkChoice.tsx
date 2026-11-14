/**
 * The deliberate choice to join a Wi-Fi network that has no password, with
 * what it exposes. Sits under the password input it replaces.
 */
export function OpenNetworkChoice({
  checked,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <>
      <label class="field-check">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
        This network has no password
      </label>
      {checked && (
        <span class="help">
          Anyone in range can join an open network, read the device’s traffic, and steal the admin
          key when you open or unlock this console there.
        </span>
      )}
    </>
  );
}
