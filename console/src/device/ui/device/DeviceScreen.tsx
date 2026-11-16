import { Content, SectionNav } from 'linen';
import { useEffect } from 'react';
import { replacePath, usePathname } from '../../../shared/navigation';
import { sectionOf } from '../places';
import { ScreenTop } from '../ScreenTop';
import { AccessSection } from './AccessSection';
import { HardwareSection } from './HardwareSection';
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
          <HardwareSection />
        ) : section === 'access' ? (
          <AccessSection />
        ) : (
          <WifiSection />
        )}
      </Content>
    </>
  );
}
