import { useEffect, useState } from 'preact/hooks';
import { ApiTab } from './components/ApiTab';
import { AudioTab } from './components/AudioTab';
import { BridgeWizard } from './components/BridgeWizard';
import { InputWizard } from './components/InputWizard';
import { Masthead } from './components/Masthead';
import { NetworkTab } from './components/NetworkTab';
import { Notice } from './components/Notice';
import { OnboardingOverlay } from './components/OnboardingOverlay';
import { OverviewTab } from './components/OverviewTab';
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
  viewHref,
} from './state/navigation';
import { toast } from './state/toasts';
import { setupWizardRequested } from './state/transport';

export function App() {
  const view = useConsoleView();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [bridgeWizardOpen, setBridgeWizardOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingSeen, setOnboardingSeen] = useState(false);
  const writable = useWritable();

  // An unconfigured device goes straight into first-run onboarding, once.
  const setup = setupMode.value;
  useEffect(() => {
    if (setup && !onboardingSeen) {
      setOnboardingSeen(true);
      setOnboardingOpen(true);
    }
  }, [setup, onboardingSeen]);

  // The lock state gates whole cards through CSS (`body.locked .gated`).
  useEffect(() => {
    document.body.classList.toggle('locked', !writable);
  }, [writable]);

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

  /** Clip-callout action: land on the audio tab; calibrate when unlocked. */
  function calibrateFromCallout() {
    navigateTo('audio');
    if (writable) openWizard();
  }

  function activeView(selected: ConsoleView) {
    switch (selected) {
      case 'overview':
        return <OverviewTab onCalibrate={calibrateFromCallout} onSetupBridge={openBridgeWizard} />;
      case 'audio':
        return <AudioTab onCalibrate={openWizard} />;
      case 'network':
        return <NetworkTab onSetupBridge={openBridgeWizard} />;
      case 'system':
        return <SystemTab />;
      case 'api':
        return <ApiTab />;
    }
  }

  return (
    <main class="wrap">
      <Masthead />

      {handoff.value ? (
        <Notice tone="warn">{handoffMessage()}</Notice>
      ) : (
        unreachable.value && <Notice tone="warn">Device unreachable — retrying…</Notice>
      )}

      <nav class="tabs" aria-label="Console">
        {CONSOLE_NAVIGATION.map(({ view: destination, label }) => (
          <a
            id={`nav-${destination}`}
            key={destination}
            href={viewHref(destination)}
            aria-current={view === destination ? 'page' : undefined}
          >
            {label}
          </a>
        ))}
      </nav>

      <section class="view active" aria-labelledby={`nav-${view}`} key={view}>
        {activeView(view)}
      </section>

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
            navigateTo('network');
          }}
        />
      )}

      <Toasts />
    </main>
  );
}
