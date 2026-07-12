import type { ComponentChildren, JSX } from 'preact';

export type ButtonKind = 'primary' | 'secondary' | 'danger';

interface ButtonProps
  extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'class' | 'className'> {
  children: ComponentChildren;
  kind?: ButtonKind;
  busy?: boolean;
  className?: string;
}

export function Button({
  children,
  kind = 'secondary',
  busy = false,
  className = '',
  disabled,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      class={`btn ${kind}${busy ? ' busy' : ''}${className ? ` ${className}` : ''}`}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy && <span class="spin" aria-hidden="true" />}
      {children}
    </button>
  );
}
