import { render } from 'preact';
import { describe, expect, it } from 'vitest';
import { Toasts } from '../src/components/Toasts';
import { toast, toasts } from '../src/state/toasts';

describe('Toasts', () => {
  it('announces errors assertively and everything else politely', () => {
    toasts.value = [];
    toast('saved', 'ok', 0);
    toast('broken', 'err', 0);
    toast('waiting', 'wait', 0);

    const host = document.createElement('div');
    render(<Toasts />, host);

    const roles = [...host.querySelectorAll('.toast')].map((t) => t.getAttribute('role'));
    expect(roles).toEqual(['status', 'alert', 'status']);
    toasts.value = [];
  });
});
