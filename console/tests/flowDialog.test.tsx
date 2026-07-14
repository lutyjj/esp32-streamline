import { render } from 'preact';
import { act } from 'preact/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { FlowDialog, type FlowStep } from '../src/components/FlowDialog';

function steps(onNext: () => void, onBack: () => void): FlowStep[] {
  return [
    { id: 'one', body: <p>first body</p>, primary: { label: 'Next', onClick: onNext } },
    {
      id: 'two',
      body: <p>second body</p>,
      secondary: [{ label: 'Back', onClick: onBack }],
      primary: { label: 'Finish', onClick: () => {}, disabled: true },
    },
    { id: 'wait', body: <p>waiting body</p> },
  ];
}

describe('FlowDialog', () => {
  it('renders the current step from data: dots, body, and footer actions', () => {
    const onNext = vi.fn();
    const host = document.createElement('div');
    render(
      <FlowDialog
        label="Test flow"
        steps={steps(onNext, () => {})}
        current="one"
        onDismiss={() => {}}
        dismissLabel="Leave"
      />,
      host,
    );

    expect(host.querySelectorAll('.stepdots i')).toHaveLength(3);
    expect(host.textContent).toContain('first body');
    const labels = [...host.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toEqual(['Leave', 'Next']);

    const next = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Next');
    act(() => next?.click());
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('lays out secondary actions before the primary and honors its guard', () => {
    const onBack = vi.fn();
    const host = document.createElement('div');
    render(
      <FlowDialog
        label="Test flow"
        steps={steps(() => {}, onBack)}
        current="two"
        onDismiss={() => {}}
      />,
      host,
    );

    const labels = [...host.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toEqual(['Cancel', 'Back', 'Finish']);
    const finish = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Finish',
    );
    expect(finish?.disabled).toBe(true);
  });

  it('offers only the dismiss escape on steps that wait', () => {
    let dismissed = false;
    const host = document.createElement('div');
    render(
      <FlowDialog
        label="Test flow"
        steps={steps(
          () => {},
          () => {},
        )}
        current="wait"
        onDismiss={() => {
          dismissed = true;
        }}
      />,
      host,
    );

    const buttons = [...host.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Cancel']);
    act(() => buttons[0]?.click());
    expect(dismissed).toBe(true);
  });
});
