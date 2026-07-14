import { useRef, useState } from 'preact/hooks';
import { getStatus, setAudio } from '../lib/api';
import {
  CAL_ATTEN_MAX,
  CAL_ATTEN_STEP,
  CalibrationEngine,
  type LevelSample,
} from '../lib/calibration';
import { errorMessage } from '../lib/errors';
import { dbfs } from '../lib/format';
import { useWritable } from '../lib/hooks';
import { loadDeviceSettings, status } from '../state/device';
import { toast } from '../state/toasts';
import { AnalogPassthroughToggle } from './AnalogPassthrough';
import { FlowDialog, type FlowStep } from './FlowDialog';
import { Kv } from './Kv';
import { MeterRow } from './Meter';

interface LogLine {
  text: string;
  cls: '' | 'ok';
}

interface AudioBaseline {
  line: number;
  gain: number;
  atten: number;
}

type WizardStep = 'prepare' | 'silence' | 'loud' | 'passthrough' | 'done';

/**
 * Input setup guide: measure the source and pick the ADC attenuation, then —
 * on boards that advertise it — choose the analog passthrough route. Cancel
 * restores the entry levels; the passthrough choice applies immediately and
 * is its own control, not part of the restore.
 */
export function InputWizard({ onClose }: { onClose: () => void }) {
  const writable = useWritable();
  const [step, setStep] = useState<WizardStep>('prepare');
  const [floor, setFloor] = useState<number | null>(null);
  const [floorText, setFloorText] = useState('—');
  const [floorOk, setFloorOk] = useState(false);
  const [silenceNote, setSilenceNote] = useState('');
  const [progress, setProgress] = useState(0);
  const [live, setLive] = useState({ rms: 0, peak: 0 });
  const [log, setLog] = useState<LogLine[]>([]);
  const [result, setResult] = useState<{ atten: number; peakDb: string } | null>(null);

  const engine = useRef<CalibrationEngine | null>(null);
  const original = useRef<AudioBaseline>({
    line: status.value?.audio.input_line ?? 2,
    gain: status.value?.audio.input_gain ?? 0,
    atten: status.value?.audio.adc_attenuation_db ?? 0,
  });
  /** Board-reported ceiling; the wizard never walks past what the ADC has. */
  const attenMax = status.value?.capabilities.adc_atten_max_db ?? CAL_ATTEN_MAX;
  const passthrough = status.value?.capabilities.analog_passthrough;

  function newEngine(): CalibrationEngine {
    engine.current?.cancel();
    const applied = engine.current?.applied ?? null;
    const next = new CalibrationEngine(
      {
        sample: async (): Promise<LevelSample> => {
          const s = await getStatus();
          return {
            rms: Math.max(s.metrics.rms_left, s.metrics.rms_right),
            peak: Math.max(s.metrics.peak_abs_left, s.metrics.peak_abs_right),
            clipped: s.metrics.clipped_samples_total,
            threshold: s.metrics.clip_threshold_abs,
          };
        },
        applyAttenuation: async (atten) => {
          const o = original.current;
          await setAudio({
            input_line: o.line,
            input_gain: o.gain,
            adc_attenuation_db: atten,
          });
        },
        delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        log: (text, cls = '') => setLog((lines) => [...lines, { text, cls }]),
        levels: (s) => setLive({ rms: s.rms, peak: s.peak }),
        silenceProgress: (fraction, rms) => {
          setProgress(fraction);
          setFloorText(rms ? dbfs(rms) : '−∞');
        },
      },
      { attenMax, attenStep: CAL_ATTEN_STEP },
    );
    // Carry the last applied attenuation across step re-entries so cancel can
    // still restore the pre-wizard value.
    next.applied = applied;
    engine.current = next;
    return next;
  }

  async function runSilence() {
    setFloorOk(false);
    setSilenceNote('');
    setFloorText('—');
    setProgress(0);
    const outcome = await newEngine().measureSilence();
    if (outcome.kind === 'cancelled') return;
    setFloorText(outcome.floor ? dbfs(outcome.floor) : '−∞');
    if (outcome.kind === 'playback-detected') {
      setSilenceNote(
        'That sounds like playback, not silence — pause the source, then measure again.',
      );
      return;
    }
    setFloor(outcome.floor);
    setFloorOk(true);
  }

  async function runLoud() {
    setLog([]);
    const outcome = await newEngine().findAttenuation(floor ?? 0);
    if (outcome.kind === 'cancelled') return;
    if (outcome.kind === 'apply-failed') {
      setLog((lines) => [
        ...lines,
        { text: `Could not set attenuation: ${outcome.message}`, cls: '' },
      ]);
      return;
    }
    if (outcome.kind === 'still-clipping-at-max') {
      setLog((lines) => [
        ...lines,
        {
          text: `Still clipping at ${attenMax} dB — turn the source volume down, then go Back and retry.`,
          cls: '',
        },
      ]);
      return;
    }
    setResult({ atten: outcome.atten, peakDb: outcome.peakDb });
    // The calibrated value is already live on the device; refresh the audio form.
    loadDeviceSettings().catch(() => {});
    show(passthrough ? 'passthrough' : 'done');
  }

  function show(next: WizardStep) {
    engine.current?.cancel();
    setStep(next);
    if (next === 'silence') runSilence();
    if (next === 'loud') runLoud();
  }

  async function close(restore: boolean) {
    const active = engine.current;
    active?.cancel();
    const o = original.current;
    onClose();
    if (!restore || !active) return;
    try {
      if (await active.restore(o.atten)) {
        toast(`Put ADC attenuation back to ${o.atten} dB`, 'ok');
        loadDeviceSettings().catch(() => {});
      }
    } catch (error) {
      toast(`Could not restore previous levels: ${errorMessage(error)}`, 'err');
    }
  }

  const doneRows: [string, string][] = result
    ? [
        [
          'ADC attenuation',
          `${result.atten} dB${
            result.atten === original.current.atten
              ? ' — unchanged'
              : ` (was ${original.current.atten} dB)`
          }`,
        ],
        ['Loudest peak', `${result.peakDb} dBFS, no clipping`],
        ['Input gain', `${original.current.gain} — unchanged`],
        ...(passthrough
          ? [
              [
                'Analog passthrough',
                status.value?.analog_passthrough.enabled ? `On — ${passthrough.label}` : 'Off',
              ] as [string, string],
            ]
          : []),
      ]
    : [];

  const steps: FlowStep[] = [
    {
      id: 'prepare',
      body: (
        <div>
          <h3>Set up your input</h3>
          <div class="body">
            <p>
              StreamLine measures your source and picks the ADC attenuation for you
              {passthrough ? ', then offers the local analog output' : ''}. Takes about a minute.
              You’ll need:
            </p>
            <ol class="checklist">
              <li>
                <b>Your source connected</b> to the line input and powered on
              </li>
              <li>
                <b>Something loud to play</b> — the most dynamic track you have nearby
              </li>
            </ol>
            <p>
              Levels change live while it runs — streaming keeps going. Cancelling puts your current
              settings back.
            </p>
          </div>
        </div>
      ),
      primary: { label: 'Start', onClick: () => show('silence') },
    },
    {
      id: 'silence',
      body: (
        <div>
          <h3>First, measure the quiet</h3>
          <div class="body">
            <p>
              Leave everything connected, but pause playback on your source. StreamLine listens for
              a few seconds to learn its idle level.
            </p>
          </div>
          <div class="bigread">
            <span class="n">{floorText}</span>
            <span class="l">dBFS idle level</span>
          </div>
          <div class="progress">
            <i style={{ width: `${progress * 100}%` }} />
          </div>
          {silenceNote && <p class="body wznote">{silenceNote}</p>}
        </div>
      ),
      secondary: [{ label: 'Back', onClick: () => show('prepare') }],
      primary: {
        label: silenceNote ? 'Measure again' : 'Continue',
        disabled: !floorOk && !silenceNote,
        onClick: () => show(floorOk ? 'loud' : 'silence'),
      },
    },
    {
      id: 'loud',
      body: (
        <div>
          <h3>Now play the loudest track you have</h3>
          <div class="body">
            <p>
              Starting from 0 dB, StreamLine raises the attenuation until loud passages stop
              clipping.
            </p>
          </div>
          <div class="meter">
            <MeterRow label="In" rms={live.rms} peak={live.peak} />
          </div>
          <div class="log wizlog">
            {log.map((line, i) => (
              <div key={i} class={line.cls}>
                {line.text}
              </div>
            ))}
          </div>
        </div>
      ),
      secondary: [{ label: 'Back', onClick: () => show('silence') }],
    },
    ...(passthrough
      ? [
          {
            id: 'passthrough',
            body: (
              <div>
                <h3>Play it locally too?</h3>
                <div class="body">
                  <p>
                    Your board can also play the selected input straight out of {passthrough.label}{' '}
                    while it streams — for speakers or an amp next to the device. Off is the usual
                    choice when everything plays through the network.
                  </p>
                </div>
                {status.value && (
                  <AnalogPassthroughToggle
                    capability={passthrough}
                    status={status.value.analog_passthrough}
                    disabled={!writable}
                  />
                )}
              </div>
            ),
            primary: { label: 'Continue', onClick: () => show('done') },
          } satisfies FlowStep,
        ]
      : []),
    {
      id: 'done',
      body: (
        <div>
          <h3>Input set up</h3>
          <div class="body">
            <p>
              {result?.atten === original.current.atten
                ? 'Your current level was already right — nothing changed.'
                : 'Applied and saved — the device is already running with the new setting.'}
            </p>
          </div>
          <Kv rows={doneRows} />
        </div>
      ),
      primary: { label: 'Done', onClick: () => close(false) },
    },
  ];

  return (
    <FlowDialog
      label="Input setup"
      steps={steps}
      current={step}
      onDismiss={() => close(true)}
      dismissLabel={step === 'done' ? 'Undo levels and close' : 'Cancel'}
    />
  );
}
