import type { ComponentChildren } from 'preact';

/** Status tone shared by chips, the status dot, and banners. */
export type Tone = 'neutral' | 'good' | 'warn' | 'bad';

interface ChipProps {
  children: ComponentChildren;
  /** Colours the text and the optional dot; neutral stays muted. */
  tone?: Tone;
  /** Show a leading status dot in the chip's tone. */
  dot?: boolean;
  className?: string;
}

/**
 * The one status token for both consoles: a rounded pill with an optional
 * tone-coloured dot. Version, sample rate, address, source lifecycle, and
 * recording state all render through this so they share a height and voice.
 */
export function Chip({ children, tone = 'neutral', dot = false, className = '' }: ChipProps) {
  const toneClass = tone === 'neutral' ? '' : ` ${tone}`;
  return (
    <span class={`chip${toneClass}${className ? ` ${className}` : ''}`}>
      {dot && <span class={`statusdot ${tone === 'neutral' ? '' : tone}`} />}
      {children}
    </span>
  );
}
