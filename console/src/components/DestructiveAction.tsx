import { useEffect, useRef, useState } from 'preact/hooks';
import { Button } from './Button';

/** A named destructive operation keeps its confirmation open on rejection. */
export function DestructiveAction({
  label,
  title,
  message,
  disabled,
  run,
}: {
  label: string;
  title: string;
  message: string;
  disabled?: boolean;
  run: () => Promise<string | undefined>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    cancel.current?.focus();
  }, [open]);
  function close() {
    if (busy) return;
    dialog.current?.close();
    setOpen(false);
    trigger.current?.querySelector('button')?.focus();
  }
  return (
    <span ref={trigger}>
      <Button
        disabled={disabled}
        onClick={() => {
          setError('');
          setOpen(true);
        }}
      >
        {label}
      </Button>
      {open && (
        <dialog
          class="sheet"
          ref={dialog}
          aria-label={title}
          onCancel={(event) => {
            event.preventDefault();
            close();
          }}
        >
          <div class="sheetcontent">
            <h2>{title}</h2>
            <p>{message}</p>
            {error && (
              <p role="alert" class="err">
                {error}
              </p>
            )}
          </div>
          <div class="sheetfoot">
            <button
              ref={cancel}
              type="button"
              class="btn secondary"
              disabled={busy}
              onClick={close}
            >
              Cancel
            </button>
            <Button
              kind="danger"
              busy={busy}
              disabled={disabled}
              onClick={async () => {
                setBusy(true);
                try {
                  const problem = await run();
                  if (problem) setError(problem);
                  else {
                    dialog.current?.close();
                    setOpen(false);
                    trigger.current?.querySelector('button')?.focus();
                  }
                } catch (reason) {
                  setError(reason instanceof Error ? reason.message : String(reason));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {label}
            </Button>
          </div>
        </dialog>
      )}
    </span>
  );
}
