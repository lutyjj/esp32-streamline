import type { ComponentChildren } from 'preact';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Short setting name; keep it under a few words. */
  label: ComponentChildren;
  /** One sentence on what turning it on does. Stacks under the label. */
  description?: ComponentChildren;
}

/**
 * The on/off switch shared by both consoles for boolean settings that apply
 * immediately. Options that need explanation pass a `description`; plain
 * inline switches pass only a `label`.
 */
export function Toggle({ checked, onChange, disabled = false, label, description }: ToggleProps) {
  return (
    <label class={description ? 'switch switch-stacked' : 'switch'}>
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span class="knob" />
      {description ? (
        <span class="switch-copy">
          <strong>{label}</strong>
          <small>{description}</small>
        </span>
      ) : (
        label
      )}
    </label>
  );
}
