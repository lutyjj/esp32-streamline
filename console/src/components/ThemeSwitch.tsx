import { useState } from 'preact/hooks';
import {
  isThemePreference,
  saveThemePreference,
  storedThemePreference,
  THEME_PREFERENCES,
  type ThemePreference,
} from '../lib/theme';

const LABELS: Record<ThemePreference, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

/** Browser-local color preference shared by console pages on the same origin. */
export function ThemeSwitch() {
  const [preference, setPreference] = useState(storedThemePreference);

  function selectTheme(value: string) {
    if (!isThemePreference(value)) return;
    saveThemePreference(value);
    setPreference(value);
  }

  return (
    <fieldset class="theme-switch" aria-label="Theme">
      <legend class="sr-only">Theme</legend>
      {THEME_PREFERENCES.map((option) => (
        <label key={option}>
          <input
            type="radio"
            name="theme"
            value={option}
            checked={preference === option}
            onChange={(event) => selectTheme(event.currentTarget.value)}
          />
          <span>{LABELS[option]}</span>
        </label>
      ))}
    </fieldset>
  );
}
