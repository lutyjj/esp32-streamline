import {
  RailChoice,
  SegmentedControl,
  SettingRow,
  THEME_PREFERENCES,
  type ThemePreference,
} from 'linen';
import { SunMoon } from 'lucide-react';
import { theme } from './theme';

const THEME_WORDS: Record<ThemePreference, string> = {
  system: 'Auto',
  light: 'Light',
  dark: 'Dark',
};

function ThemeControl() {
  const { preference, setPreference } = theme.useTheme();
  return (
    <SegmentedControl
      label="Theme"
      value={preference}
      options={THEME_PREFERENCES.map((value) => ({ value, label: THEME_WORDS[value] }))}
      onValueChange={setPreference}
    />
  );
}

/** The theme this browser shows the console in, at the rail's foot on a desk. */
export function ThemeChoice() {
  return (
    <RailChoice icon={SunMoon} label="Theme">
      <ThemeControl />
    </RailChoice>
  );
}

/** The same choice as a row of This browser, where a phone, which has no rail, finds it. */
export function ThemeSetting() {
  return (
    <SettingRow title="Theme" description="Auto follows your system's light or dark setting.">
      <ThemeControl />
    </SettingRow>
  );
}
