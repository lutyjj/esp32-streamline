export type LockState = 'locked' | 'unlocked' | 'neutral';

interface LockChipProps {
  /** `neutral` while the state is still unknown (e.g. checking). */
  state: LockState;
  text: string;
  sub?: string;
  onClick: () => void;
}

/**
 * The masthead lock affordance shared by both consoles: a pill that names the
 * write-access state and toggles it on click. Both consoles read the same way —
 * dot, label, and a hint on how to change it.
 */
export function LockChip({ state, text, sub, onClick }: LockChipProps) {
  const stateClass = state === 'neutral' ? '' : state;
  return (
    <button class={`lockchip ${stateClass}`} type="button" onClick={onClick}>
      <span class="dot" />
      <span>{text}</span>
      {sub && <small>{sub}</small>}
    </button>
  );
}
