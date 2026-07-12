import { THEME_PREFERENCES, type ThemePreference } from '../lib/preferences';
import { useThemePreference } from '../state/theme';

const LABELS: Record<ThemePreference, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

export function ThemeSwitch() {
  const { preference, selectThemePreference } = useThemePreference();

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
            onChange={(event) => selectThemePreference(event.currentTarget.value)}
          />
          <span>{LABELS[option]}</span>
        </label>
      ))}
    </fieldset>
  );
}
