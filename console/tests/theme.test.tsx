import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { ThemeSwitch } from '../src/components/ThemeSwitch';
import {
  CONSOLE_PREFERENCES_SCHEMA_VERSION,
  CONSOLE_PREFERENCES_STORAGE_KEY,
  loadConsolePreferences,
  type PreferenceStorage,
  updateConsolePreference,
} from '../src/lib/preferences';
import { initializeThemePreference } from '../src/state/theme';

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

function memoryStorage(): { storage: PreferenceStorage; values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
    values,
  };
}

describe('console preferences', () => {
  it('uses System when storage has no recognized record', () => {
    const { storage, values } = memoryStorage();
    values.set(CONSOLE_PREFERENCES_STORAGE_KEY, '{"version":2,"theme":"dark"}');

    expect(loadConsolePreferences(storage)).toEqual({ theme: 'system' });
  });

  it('writes the canonical versioned record through the supplied storage', () => {
    const { storage, values } = memoryStorage();

    expect(updateConsolePreference('theme', 'dark', storage)).toEqual({ theme: 'dark' });
    expect(values.get(CONSOLE_PREFERENCES_STORAGE_KEY)).toBe(
      JSON.stringify({ version: CONSOLE_PREFERENCES_SCHEMA_VERSION, theme: 'dark' }),
    );
  });

  it('initializes the persisted preference before rendering', () => {
    localStorage.setItem(
      CONSOLE_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ version: CONSOLE_PREFERENCES_SCHEMA_VERSION, theme: 'light' }),
    );

    expect(initializeThemePreference()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('falls back and continues when storage throws', () => {
    const storage: PreferenceStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };

    expect(loadConsolePreferences(storage)).toEqual({ theme: 'system' });
    expect(updateConsolePreference('theme', 'dark', storage)).toEqual({ theme: 'dark' });
  });
});

describe('ThemeSwitch', () => {
  it('exposes System, Light, and Dark choices and stores the selected one', () => {
    const host = document.createElement('div');
    render(<ThemeSwitch />, host);

    const choices = [...host.querySelectorAll<HTMLInputElement>('input[type=radio]')];
    expect(choices.map((choice) => choice.value)).toEqual(['system', 'light', 'dark']);

    const light = choices.find((choice) => choice.value === 'light');
    if (!light) throw new Error('light theme choice missing');
    light.checked = true;
    light.dispatchEvent(new Event('change', { bubbles: true }));

    expect(loadConsolePreferences()).toEqual({ theme: 'light' });
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
