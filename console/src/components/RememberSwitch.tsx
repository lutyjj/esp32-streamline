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
    <label class="switch">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span class="knob" />
      Remember on this browser
    </label>
  );
}
