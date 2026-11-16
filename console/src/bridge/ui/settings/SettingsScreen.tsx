import { useQuery } from '@tanstack/preact-query';
import { Content, SectionNav } from 'linen';
import { useEffect } from 'react';
import { replacePath, usePathname } from '../../../shared/navigation';
import { queryClient } from '../../../shared/queries';
import { ReadNotice } from '../../../shared/ReadNotice';
import { statusQuery } from '../../state/queries';
import { itemOf } from '../places';
import { ScreenTop } from '../ScreenTop';
import { DeploymentSection } from './DeploymentSection';
import { SecuritySection } from './SecuritySection';

const SECTIONS = [
  { href: '/settings/security', label: 'Audio security' },
  { href: '/settings/deployment', label: 'Deployment' },
] as const;

export function SettingsScreen() {
  const section = itemOf(usePathname());
  const known = SECTIONS.some((entry) => entry.href === `/settings/${section}`);
  const status = useQuery(statusQuery, queryClient);
  useEffect(() => {
    if (!known) replacePath('/settings/security');
  }, [known]);
  return (
    <>
      <ScreenTop title="Settings" />
      <SectionNav label="Settings" sections={SECTIONS} />
      <Content>
        {!status.data ? (
          <ReadNotice read={status} name="bridge status" />
        ) : section === 'deployment' ? (
          <DeploymentSection known={status.data} />
        ) : (
          <SecuritySection known={status.data} />
        )}
      </Content>
    </>
  );
}
