import type { ComponentChildren } from 'preact';
import { copyText } from '../lib/custody';
import { errorMessage } from '../lib/errors';
import { toast } from '../state/toasts';
import { Button, type ButtonKind } from './Button';

/**
 * Copy a value to the clipboard and confirm with a toast. The one copy
 * affordance across the console: success shows `copied`, failure shows the
 * clipboard error.
 */
export function CopyButton({
  value,
  copied,
  children,
  kind,
  className,
}: {
  value: string;
  /** Toast shown once the value reaches the clipboard. */
  copied: string;
  children: ComponentChildren;
  kind?: ButtonKind;
  className?: string;
}) {
  return (
    <Button
      kind={kind}
      className={className}
      onClick={() =>
        copyText(value).then(
          () => toast(copied, 'ok'),
          (error) => toast(errorMessage(error), 'err'),
        )
      }
    >
      {children}
    </Button>
  );
}
