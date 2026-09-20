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
    <label class="theme-picker">
      <span>Theme</span>
      <select
        aria-label="Theme"
        value={preference}
        onChange={(event) => selectThemePreference(event.currentTarget.value as ThemePreference)}
      >
        {THEME_PREFERENCES.map((option) => (
          <option key={option} value={option}>
            {LABELS[option]}
          </option>
        ))}
      </select>
    </label>
  );
}
