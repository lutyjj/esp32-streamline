import { useState } from 'preact/hooks';
import {
  isThemePreference,
  loadConsolePreferences,
  type ThemePreference,
  updateConsolePreference,
} from '../lib/preferences';

export function initializeThemePreference(
  root: HTMLElement = document.documentElement,
): ThemePreference {
  const preference = loadConsolePreferences().theme;
  applyThemePreference(preference, root);
  return preference;
}

export function useThemePreference() {
  const [preference, setPreference] = useState(() => loadConsolePreferences().theme);

  function selectThemePreference(value: string): void {
    if (!isThemePreference(value)) return;
    updateConsolePreference('theme', value);
    applyThemePreference(value);
    setPreference(value);
  }

  return { preference, selectThemePreference };
}

function applyThemePreference(
  preference: ThemePreference,
  root: HTMLElement = document.documentElement,
): void {
  root.dataset.theme = preference;
}
