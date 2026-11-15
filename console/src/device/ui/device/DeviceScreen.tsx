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
import { config, status } from '../../state/device';
import { sectionOf } from '../places';
import { ScreenTop } from '../ScreenTop';

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
        {section === 'hardware' ? <Hardware /> : section === 'access' ? <Access /> : <WiFi />}
      </Content>
    </>
  );
}

function WiFi() {
  const wifi = status.value?.wifi;
  if (!wifi) return null;
  return (
    <Card>
      <CardHead title="Wi-Fi" description="The network the device joins at every start." />
      <SettingRow title="Network">
        <span className="text-sm">{wifi.ssid || 'None saved'}</span>
      </SettingRow>
      <SettingRow title="Address">
        <span className="font-mono text-sm">{wifi.sta_ip || wifi.ap_ip || 'None'}</span>
      </SettingRow>
      <SettingRow title="Name on the network">
        <span className="font-mono text-sm">{wifi.hostname}</span>
      </SettingRow>
      {wifi.sta_ip && (
        <SettingRow title="Signal">
          <span className="text-sm tabular-nums">{wifi.rssi_dbm} dBm</span>
        </SettingRow>
      )}
    </Card>
  );
}

function Hardware() {
  const capabilities = status.value?.capabilities;
  const settings = config.value;
  if (!capabilities) return null;
  return (
    <div className="grid gap-4">
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
