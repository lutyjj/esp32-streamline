import { useQuery } from '@tanstack/preact-query';
import {
  type Condition,
  Elapsed,
  LinenProvider,
  Shell,
  ToastProvider,
  UnsavedChangesGuard,
} from 'linen';
import { useEffect } from 'react';
import icon from '../../icon.svg';
import { CredentialDialog } from '../../shared/CredentialDialog';
import { hashNavigation, replacePath, usePathname } from '../../shared/navigation';
import { queryClient } from '../../shared/queries';
import { ThemeChoice } from '../../shared/ThemeChoice';
import { PeerContext } from '../../shared/writeFailure';
import { whereToSet } from '../lib/deployment';
import { unlockWithToken } from '../state/access';
import { statusQuery } from '../state/queries';
import { PLACES, placeOf } from './places';
import { RecordingsScreen } from './recordings/RecordingsScreen';
import { SettingsScreen } from './settings/SettingsScreen';
import { SourcesScreen } from './sources/SourcesScreen';

/** The page's Content Security Policy nonce, which the bridge puts on every script it serves. */
const NONCE = document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce || undefined;

export function App() {
  return (
    <LinenProvider navigation={hashNavigation} nonce={NONCE}>
      <PeerContext.Provider value="bridge">
        <ToastProvider>
          <UnsavedChangesGuard>
            <BridgeShell />
          </UnsavedChangesGuard>
          <CredentialDialog
            title="Unlock the bridge"
            description={`Changes on this bridge need its API token, set as ${whereToSet('token')}. This tab keeps it until you lock or close it.`}
            label="Bridge API token"
            rejected="The bridge did not accept this token. Check it and try again."
            verify={unlockWithToken}
          />
        </ToastProvider>
      </PeerContext.Provider>
    </LinenProvider>
  );
}

function BridgeShell() {
  const path = usePathname();
  const place = placeOf(path);
  useEffect(() => {
    if (!place) replacePath('/sources');
  }, [place]);
  const mark = <img src={icon} alt="" className="size-5" />;
  return (
    <Shell
      label="Bridge console"
      places={PLACES}
      home={{ href: '/sources', label: 'StreamLine bridge' }}
      wordmark={
        <span className="flex items-center gap-2 font-display text-md font-semibold">
          {mark}
          StreamLine bridge
        </span>
      }
      mark={mark}
      storageKey="streamline:bridge-rail"
      screen={place ?? 'sources'}
      conditions={useContactConditions()}
      foot={<ThemeChoice />}
    >
      {place === 'recordings' ? (
        <RecordingsScreen />
      ) : place === 'settings' ? (
        <SettingsScreen />
      ) : (
        <SourcesScreen />
      )}
    </Shell>
  );
}

/** While status reads fail, every screen says the bridge is away, and since when once it had answered. */
function useContactConditions(): Condition[] {
  const status = useQuery(statusQuery, queryClient);
  if (!status.isError) return [];
  const since = status.data === undefined ? null : status.dataUpdatedAt;
  return [
    {
      id: 'contact',
      tone: 'danger',
      title: 'The bridge is not answering.',
      description: (
        <>
          Live values are unavailable until it does. The console keeps trying.
          {since !== null && (
            <>
              {' '}
              <Elapsed since={since} />
            </>
          )}
        </>
      ),
    },
  ];
}
