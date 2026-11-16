import { afterEach, describe, expect, it } from 'vitest';
import {
  CONSOLE_PREFERENCES_SCHEMA_VERSION,
  CONSOLE_PREFERENCES_STORAGE_KEY,
  loadConsolePreferences,
  type PreferenceStorage,
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
  });
});
