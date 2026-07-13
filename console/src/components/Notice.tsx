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
  return <div class={`notice${toneClass}`}>{children}</div>;
}
