import { useEffect, useState } from 'preact/hooks';
import { AudioTab } from './components/AudioTab';
import { BridgeWizard } from './components/BridgeWizard';
import { PageHeading } from './components/ConsoleNavigation';
import { ConsoleShell } from './components/ConsoleShell';
import { InputWizard } from './components/InputWizard';
import { Masthead } from './components/Masthead';
import { NetworkTab } from './components/NetworkTab';
import { Notice } from './components/Notice';
import { OnboardingOverlay } from './components/OnboardingOverlay';
import { SystemTab } from './components/SystemTab';
import { Toasts } from './components/Toasts';
import { TransportWizard } from './components/TransportWizard';
import { useWritable } from './lib/hooks';
import { setupMode, status, unreachable } from './state/device';
import { handoff, handoffMessage } from './state/join';
import {
  CONSOLE_NAVIGATION,
  type ConsoleView,
  navigateTo,
  useConsoleView,
} from './state/navigation';
import { toast } from './state/toasts';
import { setupWizardRequested } from './state/transport';

export function App() {
  const view = useConsoleView();
  const [visited, setVisited] = useState<ConsoleView[]>([view]);
  useEffect(() => {
    setVisited((items) => (items.includes(view) ? items : [...items, view]));
  }, [view]);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [bridgeWizardOpen, setBridgeWizardOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingSeen, setOnboardingSeen] = useState(false);
  const writable = useWritable();
  const [unlockOpen, setUnlockOpen] = useState(false);

  // An unconfigured device goes straight into first-run onboarding, once.
  const setup = setupMode.value;
  useEffect(() => {
    if (setup && !onboardingSeen) {
      setOnboardingSeen(true);
      setOnboardingOpen(true);
    }
  }, [setup, onboardingSeen]);

  function openWizard() {
    if (status.value?.mode !== 'provisioned') {
      toast('Input setup needs the device on your home network', 'err');
      return;
    }
    setWizardOpen(true);
  }

  function openBridgeWizard() {
    if (status.value?.mode !== 'provisioned') {
      toast('Bridge setup needs the device on your home network', 'err');
      return;
    }
    if (!writable) {
      toast('Unlock settings to set up the bridge', 'err');
      return;
    }
    setBridgeWizardOpen(true);
  }

  function activeView(selected: ConsoleView) {
    switch (selected) {
      case 'audio':
        return <AudioTab onCalibrate={openWizard} onSetupBridge={openBridgeWizard} />;
      case 'connections':
        return <NetworkTab onSetupBridge={openBridgeWizard} />;
      case 'settings':
        return <SystemTab />;
    }
  }

  return (
    <ConsoleShell
      items={CONSOLE_NAVIGATION}
      current={view}
      locked={!writable}
      onUnlock={() => {
        setUnlockOpen(true);
        window.scrollTo({ top: 0 });
      }}
      header={<Masthead panelOpen={unlockOpen} onPanelOpen={setUnlockOpen} />}
    >
      {handoff.value ? (
        <Notice tone="warn">{handoffMessage()}</Notice>
      ) : (
        unreachable.value && <Notice tone="warn">Device unreachable — retrying…</Notice>
      )}

      <div>
        {CONSOLE_NAVIGATION.filter(
          ({ view: destination }) => destination === view || visited.includes(destination),
        ).map((destination) => (
          <section
            class="view active"
            hidden={destination.view !== view}
            aria-labelledby={`nav-${destination.view}`}
            key={destination.view}
          >
            <PageHeading label={destination.label} description={destination.description} />
            {activeView(destination.view)}
          </section>
        ))}
      </div>

      {wizardOpen && <InputWizard onClose={() => setWizardOpen(false)} />}
      {bridgeWizardOpen && <BridgeWizard onClose={() => setBridgeWizardOpen(false)} />}
      {setupWizardRequested.value && (
        <TransportWizard
          onClose={() => {
            setupWizardRequested.value = false;
          }}
        />
      )}
      {onboardingOpen && (
        <OnboardingOverlay
          onClose={() => {
            setOnboardingOpen(false);
            navigateTo('connections');
          }}
        />
      )}

      <Toasts />
    </ConsoleShell>
  );
}
