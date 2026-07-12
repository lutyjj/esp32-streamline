export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export interface ConsolePreferences {
  theme: ThemePreference;
}

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const CONSOLE_PREFERENCES_STORAGE_KEY = 'streamline.console-preferences';
export const CONSOLE_PREFERENCES_SCHEMA_VERSION = 1;

const DEFAULT_CONSOLE_PREFERENCES: ConsolePreferences = { theme: 'system' };

export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.some((preference) => preference === value);
}

export function loadConsolePreferences(
  storage: PreferenceStorage | undefined = browserPreferenceStorage(),
): ConsolePreferences {
  if (!storage) return { ...DEFAULT_CONSOLE_PREFERENCES };
  try {
    return parseConsolePreferences(storage.getItem(CONSOLE_PREFERENCES_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_CONSOLE_PREFERENCES };
  }
}

export function updateConsolePreference<Key extends keyof ConsolePreferences>(
  key: Key,
  value: ConsolePreferences[Key],
  storage: PreferenceStorage | undefined = browserPreferenceStorage(),
): ConsolePreferences {
  const preferences = loadConsolePreferences(storage);
  preferences[key] = value;
  saveConsolePreferences(preferences, storage);
  return preferences;
}

export function saveConsolePreferences(
  preferences: ConsolePreferences,
  storage: PreferenceStorage | undefined = browserPreferenceStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(
      CONSOLE_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ version: CONSOLE_PREFERENCES_SCHEMA_VERSION, ...preferences }),
    );
  } catch {
    // The current page still applies a preference when browser storage is unavailable.
  }
}

function browserPreferenceStorage(): PreferenceStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function parseConsolePreferences(value: string | null): ConsolePreferences {
  if (!value) return { ...DEFAULT_CONSOLE_PREFERENCES };
  try {
    const parsed: unknown = JSON.parse(value);
    if (isStoredConsolePreferences(parsed)) return { theme: parsed.theme };
  } catch {
    // Storage is untrusted data; invalid records fall back to the default.
  }
  return { ...DEFAULT_CONSOLE_PREFERENCES };
}

function isStoredConsolePreferences(
  value: unknown,
): value is { version: number; theme: ThemePreference } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    'theme' in value &&
    value.version === CONSOLE_PREFERENCES_SCHEMA_VERSION &&
    isThemePreference(value.theme)
  );
}
