import { loadConsolePreferences, type ThemePreference } from '../lib/preferences';

export function initializeThemePreference(
  root: HTMLElement = document.documentElement,
): ThemePreference {
  const preference = loadConsolePreferences().theme;
  applyThemePreference(preference, root);
  return preference;
}

function applyThemePreference(
  preference: ThemePreference,
  root: HTMLElement = document.documentElement,
): void {
  root.dataset.theme = preference;
}
