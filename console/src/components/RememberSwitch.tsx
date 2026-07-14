import { Toggle } from './Toggle';

/** The "Remember on this browser" switch shown wherever a key is entered or revealed. */
export function RememberSwitch({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Toggle
      checked={checked}
      onChange={onChange}
      disabled={disabled}
      label="Remember on this browser"
    />
  );
}
