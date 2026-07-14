/**
 * A pill of mutually exclusive options, one lit. Shared by the masthead theme
 * switch and the per-LED role picker. Backed by radios so a keyboard and a
 * screen reader treat it as one control; `disabled` locks the whole group.
 */
export function Segmented<T extends string>({
  name,
  value,
  options,
  ariaLabel,
  disabled = false,
  onChange,
}: {
  name: string;
  value: T;
  options: readonly { value: T; label: string }[];
  ariaLabel: string;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset class="segmented" disabled={disabled} aria-label={ariaLabel}>
      <legend class="sr-only">{ariaLabel}</legend>
      {options.map((option) => (
        <label key={option.value}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={(event) => onChange(event.currentTarget.value as T)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}
