import type { ComponentChildren } from 'preact';

export type NoticeTone = 'info' | 'warn' | 'error';

interface NoticeProps {
  children: ComponentChildren;
  /** Default `info`; `warn` for expected waits, `error` for failures. */
  tone?: NoticeTone;
}

/**
 * A full-width banner for page-level state: connectivity waits, load failures,
 * and other messages that outlive a toast. One banner voice across both
 * consoles.
 */
export function Notice({ children, tone = 'info' }: NoticeProps) {
  const toneClass = tone === 'info' ? '' : ` ${tone}`;
  return (
    <div class={`notice${toneClass}`}>
      {tone === 'warn' && <WarningIcon />}
      {children}
    </div>
  );
}

export function WarningIcon() {
  return (
    <svg
      class="warning-icon"
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M10 2 1.5 17h17L10 2Z" />
      <path d="M10 7v4m0 3v.1" />
    </svg>
  );
}
