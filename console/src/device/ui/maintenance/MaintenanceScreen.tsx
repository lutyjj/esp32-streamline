import { Button, Card, CardHead, Content, CopyValue, SectionNav, SettingRow } from 'linen';
import { useEffect, useState } from 'react';
import {
  getFactoryResetUrl,
  getGetMetricsUrl,
  getGetOpenapiUrl,
  getRestartUrl,
  restart,
} from '../../../generated/api';
import { replacePath, usePathname } from '../../../shared/navigation';
import { WriteConfirm } from '../../../shared/WriteConfirm';
import { withRestart } from '../../state/access';
import { resetToSetup } from '../../state/handoff';
import { updateLock } from '../../state/ota';
import { sectionOf } from '../places';
import { ScreenTop } from '../ScreenTop';
import { DiagnosticsSection } from './DiagnosticsSection';
import { UpdatesSection } from './UpdatesSection';

const SECTIONS = [
  { href: '/maintenance/updates', label: 'Updates' },
  { href: '/maintenance/diagnostics', label: 'Diagnostics' },
  { href: '/maintenance/api', label: 'API' },
  { href: '/maintenance/reset', label: 'Restart & reset' },
] as const;

export function MaintenanceScreen() {
  const section = sectionOf(usePathname());
  const known = SECTIONS.some((entry) => entry.href === `/maintenance/${section}`);
  useEffect(() => {
    if (!known) replacePath('/maintenance/updates');
  }, [known]);
  return (
    <>
      <ScreenTop title="Maintenance" />
      <SectionNav label="Maintenance" sections={SECTIONS} />
      <Content>
        {section === 'diagnostics' ? (
          <DiagnosticsSection />
        ) : section === 'api' ? (
          <Api />
        ) : section === 'reset' ? (
          <RestartAndReset />
        ) : (
          <UpdatesSection />
        )}
      </Content>
    </>
  );
}

function Api() {
  const origin = window.location.origin;
  return (
    <Card>
      <CardHead
        title="Machine interface"
        description="Everything this console does is an HTTP call a script can make. Writes, the log and the crash dump need the admin key as digest authentication."
      />
      <SettingRow
        title="Contract"
        description="OpenAPI 3.1, the document this console was built from."
      >
        <CopyValue value={`${origin}${getGetOpenapiUrl()}`} label="Contract address" />
      </SettingRow>
      <SettingRow title="Metrics" description="Prometheus text, open to read.">
        <CopyValue value={`${origin}${getGetMetricsUrl()}`} label="Metrics address" />
      </SettingRow>
      <SettingRow title="A write from a terminal">
        <CopyValue
          value={`curl --digest -u "admin:$STREAMLINE_ADMIN_KEY" -X POST ${origin}${getRestartUrl()}`}
          label="Restart command"
        />
      </SettingRow>
    </Card>
  );
}

function RestartAndReset() {
  const [asked, setAsked] = useState<'restart' | 'reset' | null>(null);
  const restartHeld = updateLock(getRestartUrl());
  const resetHeld = updateLock(getFactoryResetUrl());
  const closed = (open: boolean) => {
    if (!open) setAsked(null);
  };
  return (
    <Card>
      <CardHead title="Restart and reset" />
      <SettingRow
        title="Restart"
        description={restartHeld ?? 'Audio stops for a few seconds and resumes on its own.'}
      >
        <Button disabled={restartHeld !== null} onClick={() => setAsked('restart')}>
          Restart
        </Button>
      </SettingRow>
      <SettingRow
        title="Factory reset"
        description={
          resetHeld ??
          'Erases every setting, the admin key and any crash dump, keeps the firmware, and opens the setup network.'
        }
      >
        <Button
          variant="destructive"
          disabled={resetHeld !== null}
          onClick={() => setAsked('reset')}
        >
          Factory reset
        </Button>
      </SettingRow>
      <WriteConfirm
        open={asked === 'restart'}
        onOpenChange={closed}
        title="Restart the device?"
        description="Audio stops while it restarts, and the console reconnects once it answers."
        confirmLabel="Restart"
        failed="The device did not restart."
        write={() => withRestart('the restart', () => restart())}
      />
      <WriteConfirm
        open={asked === 'reset'}
        onOpenChange={closed}
        title="Erase every setting?"
        description="The device forgets its Wi-Fi, bridge, board, profiles, encryption keys and admin key, then opens its setup network to be set up again. Its firmware stays."
        confirmLabel="Factory reset"
        destructive
        failed="The device kept its settings."
        write={resetToSetup}
      />
    </Card>
  );
}
