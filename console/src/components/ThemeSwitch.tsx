import { THEME_PREFERENCES, type ThemePreference } from '../lib/preferences';
import { useThemePreference } from '../state/theme';
import { Segmented } from './Segmented';

const LABELS: Record<ThemePreference, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

export function ThemeSwitch() {
  const { preference, selectThemePreference } = useThemePreference();

  return (
    <Segmented
      name="theme"
      ariaLabel="Theme"
      value={preference}
      options={THEME_PREFERENCES.map((option) => ({ value: option, label: LABELS[option] }))}
      onChange={selectThemePreference}
    />
  );
}
