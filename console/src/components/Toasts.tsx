import { toasts } from '../state/toasts';

export function Toasts() {
  return (
    <div class="toasts">
      {toasts.value.map((t) => (
        <div key={t.id} class={`toast ${t.kind}`} role={t.kind === 'err' ? 'alert' : 'status'}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
