export type LockState = 'locked' | 'unlocked' | 'neutral';

interface LockChipProps {
  /** `neutral` while the state is still unknown (e.g. checking). */
  state: LockState;
  text: string;
  sub?: string;
  onClick: () => void;
  /** Present when the chip toggles a panel: its expanded state and id. */
  expanded?: boolean;
  controls?: string;
}

/**
 * The masthead lock affordance shared by both consoles: a pill that names the
 * write-access state and toggles it on click. Both consoles read the same way —
 * dot, label, and a hint on how to change it.
 */
export function LockChip({ state, text, sub, onClick, expanded, controls }: LockChipProps) {
  const stateClass = state === 'neutral' ? '' : state;
  return (
    <button
      class={`lockchip ${stateClass}`}
      type="button"
      aria-expanded={expanded}
      aria-controls={expanded ? controls : undefined}
      onClick={onClick}
    >
      <span class="dot" />
      <span>{text}</span>
      {sub && <small>{sub}</small>}
    </button>
  );
}
