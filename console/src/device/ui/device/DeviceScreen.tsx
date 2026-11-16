import {
  Card,
  CardHead,
  Content,
  SectionNav,
  SegmentedControl,
  SettingRow,
  THEME_PREFERENCES,
  type ThemePreference,
} from 'linen';
import { useEffect } from 'react';
import { replacePath, usePathname } from '../../../shared/navigation';
import { theme } from '../../../shared/theme';
import { BUTTON_ACTION_SUMMARY, buttonRows } from '../../lib/buttons';
import { LED_ROLE_SUMMARY, ledRows } from '../../lib/leds';
import { config, configResource, status } from '../../state/device';
import { sectionOf } from '../places';
import { ResourceNotice } from '../ResourceNotice';
import { ScreenTop } from '../ScreenTop';
import { WifiSection } from './WifiSection';

const SECTIONS = [
  { href: '/device/wifi', label: 'Wi-Fi' },
  { href: '/device/hardware', label: 'Hardware' },
  { href: '/device/access', label: 'Access' },
] as const;

export function DeviceScreen() {
  const section = sectionOf(usePathname());
  const known = SECTIONS.some((entry) => entry.href === `/device/${section}`);
  useEffect(() => {
    if (!known) replacePath('/device/wifi');
  }, [known]);
  return (
    <>
      <ScreenTop title="Device" />
      <SectionNav label="Device" sections={SECTIONS} />
      <Content>
        {section === 'hardware' ? (
          <Hardware />
        ) : section === 'access' ? (
          <Access />
        ) : (
          <WifiSection />
        )}
      </Content>
    </>
  );
}

function Hardware() {
  const capabilities = status.value?.capabilities;
  const settings = config.value;
  if (!capabilities) return null;
  return (
    <div className="grid gap-4">
      <ResourceNotice resource={configResource} />
      <Card>
        <CardHead title="Board" />
        <SettingRow title="Model">
          <span className="text-sm">{capabilities.board}</span>
        </SettingRow>
        <SettingRow title="Codec">
          <span className="font-mono text-sm">{capabilities.codec.driver}</span>
        </SettingRow>
      </Card>
      {settings && capabilities.buttons.length > 0 && (
        <Card>
          <CardHead title="Buttons" />
          {buttonRows(capabilities.buttons, settings.button_actions).map((row) => (
            <SettingRow key={row.id} title={row.label}>
              <span className="text-sm">{BUTTON_ACTION_SUMMARY[row.action]}</span>
            </SettingRow>
          ))}
        </Card>
      )}
      {settings && capabilities.leds.length > 0 && (
        <Card>
          <CardHead title="Lights" />
          {ledRows(capabilities.leds, settings.led_roles).map((row) => (
            <SettingRow key={row.id} title={row.label}>
              <span className="text-sm">{LED_ROLE_SUMMARY[row.role]}</span>
            </SettingRow>
          ))}
        </Card>
      )}
    </div>
  );
}

const THEME_WORDS: Record<ThemePreference, string> = {
  system: 'Auto',
  light: 'Light',
  dark: 'Dark',
};

function Access() {
  const { preference, setPreference } = theme.useTheme();
  return (
    <Card>
      <CardHead title="This browser" description="What this browser keeps for this device." />
      <SettingRow title="Theme">
        <SegmentedControl
          label="Theme"
          value={preference}
          options={THEME_PREFERENCES.map((value) => ({ value, label: THEME_WORDS[value] }))}
          onValueChange={setPreference}
        />
      </SettingRow>
    </Card>
  );
}
