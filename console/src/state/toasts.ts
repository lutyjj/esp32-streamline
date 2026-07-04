import { signal } from '@preact/signals';

export type ToastKind = 'ok' | 'err' | 'wait';

export interface Toast {
  id: number;
  text: string;
  kind: ToastKind;
}

export const toasts = signal<Toast[]>([]);

let nextId = 1;

/** Show a toast; `ms: 0` keeps it until dismissed by a page change. */
export function toast(text: string, kind: ToastKind = 'ok', ms = 4000): void {
  const entry = { id: nextId, text, kind };
  nextId += 1;
  toasts.value = [...toasts.value, entry];
  if (ms) setTimeout(() => dismiss(entry.id), ms);
}

function dismiss(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}
