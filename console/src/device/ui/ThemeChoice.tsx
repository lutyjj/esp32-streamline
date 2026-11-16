import { RailChoice, SegmentedControl, THEME_PREFERENCES, type ThemePreference } from 'linen';
import { SunMoon } from 'lucide-react';
import { theme } from '../../shared/theme';

const THEME_WORDS: Record<ThemePreference, string> = {
  system: 'Auto',
  light: 'Light',
  dark: 'Dark',
};

/** The theme this browser shows the console in, at the rail's foot. */
export function ThemeChoice() {
  const { preference, setPreference } = theme.useTheme();
  return (
    <RailChoice icon={SunMoon} label="Theme">
      <SegmentedControl
        label="Theme"
        value={preference}
        options={THEME_PREFERENCES.map((value) => ({ value, label: THEME_WORDS[value] }))}
        onValueChange={setPreference}
      />
    </RailChoice>
  );
}
