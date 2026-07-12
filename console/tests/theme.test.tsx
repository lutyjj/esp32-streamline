import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { ThemeSwitch } from '../src/components/ThemeSwitch';
import {
  applyThemePreference,
  initializeThemePreference,
  saveThemePreference,
  storedThemePreference,
  THEME_STORAGE_KEY,
} from '../src/lib/theme';

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('theme preference', () => {
  it('uses System when storage has no recognized preference', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia');

    expect(storedThemePreference()).toBe('system');
  });

  it('persists and applies an explicit preference', () => {
    saveThemePreference('dark');

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('initializes the persisted preference before rendering', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');

    expect(initializeThemePreference()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('applies a preference to an explicit root', () => {
    const root = document.createElement('div');

    applyThemePreference('light', root);

    expect(root.dataset.theme).toBe('light');
  });
});

describe('ThemeSwitch', () => {
  it('exposes System, Light, and Dark choices and saves the selected one', () => {
    const host = document.createElement('div');
    render(<ThemeSwitch />, host);

    const choices = [...host.querySelectorAll<HTMLInputElement>('input[type=radio]')];
    expect(choices.map((choice) => choice.value)).toEqual(['system', 'light', 'dark']);

    const light = choices.find((choice) => choice.value === 'light');
    if (!light) throw new Error('light theme choice missing');
    light.checked = true;
    light.dispatchEvent(new Event('change', { bubbles: true }));

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
