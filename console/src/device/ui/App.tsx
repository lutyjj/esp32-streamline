import { effect, untracked } from '@preact/signals';
import {
  Content,
  EmptyState,
  LinenProvider,
  Shell,
  ToastProvider,
  UnsavedChangesGuard,
  useToast,
} from 'linen';
import { useEffect } from 'react';
import icon from '../../icon.svg';
import { CredentialDialog } from '../../shared/CredentialDialog';
import { hashNavigation, replacePath, usePathname } from '../../shared/navigation';
import { verifyKey } from '../state/access';
import { UPDATE_OPERATION } from '../state/connection';
import { connection, restartSettled, status } from '../state/device';
import { installSource, updateNews } from '../state/ota';
import { AudioHome } from './audio/AudioHome';
import { BridgeScreen } from './bridge/BridgeScreen';
import { DeviceScreen } from './device/DeviceScreen';
import { MaintenanceScreen } from './maintenance/MaintenanceScreen';
import { PLACES, placeOf } from './places';

export function App() {
  return (
    <LinenProvider navigation={hashNavigation}>
      <ToastProvider>
        <UnsavedChangesGuard>
          <Console />
        </UnsavedChangesGuard>
        <CredentialDialog
          title="Unlock settings"
          description="Settings change only with this device's admin key, which you saved when you set it up. A lost key needs a reflash."
          label="Admin key"
          username="admin"
          remember="Remember on this browser"
          rejected="The device did not accept this key. Check it and try again."
          verify={verifyKey}
        />
      </ToastProvider>
    </LinenProvider>
  );
}

/** The frame the device's mode and the connection call for. */
function Console() {
  const name = status.value?.device_name;
  useEffect(() => {
    document.title = name ? `${name} · StreamLine` : 'StreamLine';
  }, [name]);
  useRestartToasts();

  const now = connection.value;
  if (now.phase === 'handoff') return <StandIn title="The device left this network" />;
  if (status.value?.mode === 'setup') return <StandIn title="This device is not set up yet" />;
  return <DeviceShell name={name} />;
}

/** Says once that a restart finished; the toast takes the news, so it is shown only once. */
function useRestartToasts() {
  const toast = useToast();
  useEffect(
    () =>
      effect(() => {
        const settled = restartSettled.value;
        if (!settled) return;
        restartSettled.value = null;
        untracked(() => {
          const news =
            settled.operation === UPDATE_OPERATION
              ? updateNews(settled, installSource.value)
              : { text: `Back online after ${settled.operation}.`, failure: false };
          toast.show({ text: news.text, sticky: news.failure });
        });
      }),
    [toast],
  );
}

function DeviceShell({ name }: { name: string | undefined }) {
  const path = usePathname();
  const place = placeOf(path);
  useEffect(() => {
    if (!place) replacePath('/audio');
  }, [place]);
  const mark = <img src={icon} alt="" className="size-5" />;
  return (
    <Shell
      label="Device console"
      places={PLACES}
      home={{ href: '/audio', label: 'StreamLine' }}
      wordmark={
        <span className="flex items-center gap-2 font-display text-md font-semibold">
          {mark}
          {name || 'StreamLine'}
        </span>
      }
      mark={mark}
      storageKey="streamline:rail"
      screen={place ?? 'audio'}
    >
      {place === 'bridge' ? (
        <BridgeScreen />
      ) : place === 'device' ? (
        <DeviceScreen />
      ) : place === 'maintenance' ? (
        <MaintenanceScreen />
      ) : (
        <AudioHome />
      )}
    </Shell>
  );
}

/** Stand-in for the onboarding and handoff screens, which come with their milestone. */
function StandIn({ title }: { title: string }) {
  return (
    <Content>
      <EmptyState title={title} />
    </Content>
  );
}
