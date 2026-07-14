import { render } from 'preact';
import { describe, expect, it, vi } from 'vitest';
import { Segmented } from '../src/components/Segmented';

const options = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
];

describe('Segmented', () => {
  it('lights the option matching the value', () => {
    const host = document.createElement('div');
    render(
      <Segmented name="t" ariaLabel="Test" value="b" options={options} onChange={() => {}} />,
      host,
    );
    const choices = [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(choices.map((choice) => choice.value)).toEqual(['a', 'b', 'c']);
    expect(choices.find((choice) => choice.checked)?.value).toBe('b');
    expect(host.textContent).toContain('Beta');
  });

  it('reports the chosen value on change', () => {
    const host = document.createElement('div');
    const onChange = vi.fn();
    render(
      <Segmented name="t" ariaLabel="Test" value="a" options={options} onChange={onChange} />,
      host,
    );
    const gamma = [...host.querySelectorAll<HTMLInputElement>('input')].find(
      (choice) => choice.value === 'c',
    );
    if (!gamma) throw new Error('missing option');
    gamma.checked = true;
    gamma.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('disables the whole group at once', () => {
    const host = document.createElement('div');
    render(
      <Segmented
        name="t"
        ariaLabel="Test"
        value="a"
        options={options}
        disabled
        onChange={() => {}}
      />,
      host,
    );
    expect(host.querySelector<HTMLFieldSetElement>('fieldset.segmented')?.disabled).toBe(true);
  });
});
