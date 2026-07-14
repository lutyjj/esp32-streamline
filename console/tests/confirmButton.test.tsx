import { render } from 'preact';
import { act } from 'preact/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmButton } from '../src/components/ConfirmButton';

function mount(ui: Parameters<typeof render>[0]): HTMLElement {
  const host = document.createElement('div');
  render(ui, host);
  return host;
}

function buttonLabels(host: HTMLElement): string[] {
  return [...host.querySelectorAll('button')].map((b) => b.textContent || '');
}

function click(host: HTMLElement, label: string): void {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
  act(() => button?.click());
}

describe('ConfirmButton', () => {
  it('arms on the first click and confirms on the second', () => {
    const onConfirm = vi.fn();
    const host = mount(
      <ConfirmButton label="Delete" confirmLabel="Delete" onConfirm={onConfirm} />,
    );
    expect(buttonLabels(host)).toEqual(['Delete']);

    click(host, 'Delete');
    expect(buttonLabels(host)).toEqual(['Delete', 'Cancel']);
    expect(onConfirm).not.toHaveBeenCalled();

    click(host, 'Delete');
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(buttonLabels(host)).toEqual(['Delete']);
  });

  it('cancels back to the idle trigger without confirming', () => {
    const onConfirm = vi.fn();
    const host = mount(
      <ConfirmButton label="Delete" confirmLabel="Delete" onConfirm={onConfirm} />,
    );
    click(host, 'Delete');
    click(host, 'Cancel');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(buttonLabels(host)).toEqual(['Delete']);
  });

  it('shows a bordered warning box when given a message', () => {
    const host = mount(
      <ConfirmButton
        label="Factory reset"
        confirmLabel="Erase everything"
        message="This erases everything."
        onConfirm={() => {}}
      />,
    );
    expect(host.querySelector('.confirmbox')).toBeNull();
    click(host, 'Factory reset');
    const box = host.querySelector('.confirmbox');
    expect(box?.textContent).toContain('This erases everything.');
    expect(box?.textContent).toContain('Erase everything');
  });

  it('keeps the armed pair in one container so flex parents cannot scatter it', () => {
    const host = document.createElement('div');
    render(<ConfirmButton label="Remove" confirmLabel="Remove" onConfirm={() => {}} />, host);

    act(() => host.querySelector('button')?.click());

    const group = host.querySelector('.confirm-inline');
    expect(group).not.toBeNull();
    expect(group?.querySelectorAll('button')).toHaveLength(2);
  });
});
