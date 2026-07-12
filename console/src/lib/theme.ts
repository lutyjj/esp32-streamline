export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const THEME_STORAGE_KEY = 'streamline.theme';

export function isThemePreference(value: string | null): value is ThemePreference {
  return THEME_PREFERENCES.some((preference) => preference === value);
}

export function storedThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function applyThemePreference(
  preference: ThemePreference,
  root: HTMLElement = document.documentElement,
): void {
  root.dataset.theme = preference;
}

export function saveThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // A blocked storage area should not stop an in-page preference change.
  }
  applyThemePreference(preference);
}

export function initializeThemePreference(): ThemePreference {
  const preference = storedThemePreference();
  applyThemePreference(preference);
  return preference;
}
