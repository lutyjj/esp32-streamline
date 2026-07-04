import { useEffect, useState } from 'preact/hooks';
import { AudioTab } from './components/AudioTab';
import { Masthead } from './components/Masthead';
import { NetworkTab } from './components/NetworkTab';
import { OnboardingOverlay } from './components/OnboardingOverlay';
import { OverviewTab } from './components/OverviewTab';
import { SystemTab } from './components/SystemTab';
import { Toasts } from './components/Toasts';
import { WizardOverlay } from './components/WizardOverlay';
import { useWritable } from './lib/hooks';
import { setupMode, status, unreachable } from './state/device';
import { toast } from './state/toasts';

const VIEWS = ['overview', 'audio', 'network', 'system'] as const;
type View = (typeof VIEWS)[number];

const VIEW_LABELS: Record<View, string> = {
  overview: 'Overview',
  audio: 'Audio',
  network: 'Network',
  system: 'System',
};

export function App() {
  const [view, setView] = useState<View>('overview');
  const [wizardOpen, setWizardOpen] = useState(false);
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
      toast('Calibration needs the device on your home network', 'err');
      return;
    }
    setWizardOpen(true);
  }

  /** Clip-callout action: land on the audio tab; calibrate when unlocked. */
  function calibrateFromCallout() {
    setView('audio');
    if (writable) openWizard();
  }

  return (
    <main class="wrap">
      <Masthead />

      {unreachable.value && <div class="connbanner">Device unreachable — retrying…</div>}

      <div class="tabs" role="tablist">
        {VIEWS.map((v) => (
          <button
            key={v}
            role="tab"
            type="button"
            aria-selected={view === v}
            onClick={() => setView(v)}
          >
            {VIEW_LABELS[v]}
          </button>
        ))}
      </div>

      <section class={`view${view === 'overview' ? ' active' : ''}`}>
        {view === 'overview' && <OverviewTab onCalibrate={calibrateFromCallout} />}
      </section>
      <section class={`view${view === 'audio' ? ' active' : ''}`}>
        {view === 'audio' && <AudioTab onCalibrate={openWizard} />}
      </section>
      <section class={`view${view === 'network' ? ' active' : ''}`}>
        {view === 'network' && <NetworkTab />}
      </section>
      <section class={`view${view === 'system' ? ' active' : ''}`}>
        {view === 'system' && <SystemTab />}
      </section>

      {wizardOpen && <WizardOverlay onClose={() => setWizardOpen(false)} />}
      {onboardingOpen && (
        <OnboardingOverlay
          onClose={() => {
            setOnboardingOpen(false);
            setView('network');
          }}
        />
      )}

      <Toasts />
    </main>
  );
}
