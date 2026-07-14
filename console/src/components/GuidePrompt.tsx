import { Button } from './Button';

/**
 * The one row that offers a guided flow next to a manual form: a short pitch
 * and the button that opens the guide. `primary` marks the guide as the
 * expected path (nothing configured yet); otherwise it reads as an offer.
 */
export function GuidePrompt({
  text,
  action,
  onAction,
  primary = false,
  disabled = false,
}: {
  text: string;
  action: string;
  onAction: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <div class="wizentry">
      <span>{text}</span>
      <Button kind={primary ? 'primary' : 'secondary'} disabled={disabled} onClick={onAction}>
        {action}
      </Button>
    </div>
  );
}
