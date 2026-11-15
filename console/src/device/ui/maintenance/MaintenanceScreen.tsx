import {
  Button,
  Card,
  CardHead,
  ConfirmDialog,
  Content,
  CopyValue,
  SectionNav,
  SettingRow,
  useToast,
} from 'linen';
import { useEffect, useState } from 'react';
import { errorMessage } from '../../../shared/errors';
import { bytes, duration } from '../../../shared/format';
import { replacePath, usePathname } from '../../../shared/navigation';
import { restart } from '../../lib/api';
import { withAccess } from '../../state/access';
import { liveStatus, report, status } from '../../state/device';
import { updateLock } from '../../state/ota';
import { sectionOf } from '../places';
import { ScreenTop } from '../ScreenTop';

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
          <Diagnostics />
        ) : section === 'api' ? (
          <Api />
        ) : section === 'reset' ? (
          <RestartAndReset />
        ) : (
          <Updates />
        )}
      </Content>
    </>
  );
}

function Updates() {
  const known = status.value;
  if (!known) return null;
  return (
    <Card>
      <CardHead title="Firmware" />
      <SettingRow title="Running">
        <span className="font-mono text-sm">{known.firmware_version}</span>
      </SettingRow>
      {known.ota.latest_version && (
        <SettingRow title="Latest release">
          <span className="font-mono text-sm">{known.ota.latest_version}</span>
        </SettingRow>
      )}
      {known.ota.rollback_available && (
        <SettingRow title="Previous image">
          <span className="font-mono text-sm">{known.ota.rollback_version}</span>
        </SettingRow>
      )}
    </Card>
  );
}

function Diagnostics() {
  const live = liveStatus.value;
  const known = status.value;
  if (!known) return null;
  return (
    <div className="grid gap-4">
      <Card>
        <CardHead title="Startup health" />
        {known.health.checks.map((check) => (
          <SettingRow key={check.id} title={check.detail} description={check.remedy ?? undefined}>
            <span className="text-sm">
              {check.status === 'ok' ? 'OK' : check.status === 'warn' ? 'Warning' : 'Failed'}
            </span>
          </SettingRow>
        ))}
      </Card>
      {live && (
        <Card>
          <CardHead title="Resources" />
          <SettingRow title="Up for">
            <span className="text-sm tabular-nums">{duration(live.system.uptime_seconds)}</span>
          </SettingRow>
          <SettingRow title="Free memory">
            <span className="text-sm tabular-nums">
              {bytes(live.system.heap.free_bytes)} of {bytes(live.system.heap.total_bytes)}
            </span>
          </SettingRow>
          <SettingRow title="Last restart">
            <span className="text-sm">{known.diagnostics.reset_reason}</span>
          </SettingRow>
        </Card>
      )}
    </div>
  );
}

function Api() {
  const origin = window.location.origin;
  return (
    <Card>
      <CardHead
        title="Machine interface"
        description="Everything this console does is an HTTP call a script can make. Writes need the admin key as digest authentication."
      />
      <SettingRow title="Contract">
        <CopyValue value={`${origin}/api/openapi.json`} label="Contract address" />
      </SettingRow>
      <SettingRow title="A write from a terminal">
        <CopyValue
          value={`curl --digest -u "admin:$STREAMLINE_ADMIN_KEY" -X POST ${origin}/api/restart`}
          label="Restart command"
        />
      </SettingRow>
    </Card>
  );
}

function RestartAndReset() {
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const held = updateLock('/api/restart');
  const restartNow = async () => {
    try {
      const ack = await withAccess(() => restart());
      if (ack?.rebooting) report({ type: 'restarting', operation: 'the restart', at: Date.now() });
    } catch (error) {
      toast.show({ text: `The device did not restart: ${errorMessage(error)}`, sticky: true });
    }
  };
  return (
    <Card>
      <CardHead title="Restart" />
      <SettingRow
        title="Restart the device"
        description={held ?? 'Audio stops for a few seconds and resumes on its own.'}
      >
        <Button disabled={held !== null} onClick={() => setAsking(true)}>
          Restart
        </Button>
      </SettingRow>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title="Restart the device?"
        description="Audio stops while it restarts, and the console reconnects once it answers."
        confirmLabel="Restart"
        onConfirm={() => void restartNow()}
      />
    </Card>
  );
}
