import { useRef, useState } from 'preact/hooks';
import { getStatus, postForm } from '../lib/api';
import { CAL_ATTEN_MAX, CalibrationEngine, type LevelSample } from '../lib/calibration';
import { dbfs, meterPct } from '../lib/format';
import { loadConfig, status } from '../state/device';
import { toast } from '../state/toasts';
import { Kv } from './Kv';

interface LogLine {
  text: string;
  cls: '' | 'ok';
}

interface AudioBaseline {
  line: number;
  gain: number;
  atten: number;
}

/** Calibration wizard: prepare · silence · loud · done. */
export function WizardOverlay({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(1);
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
    atten: status.value?.audio.adc_atten_db ?? 0,
  });

  function newEngine(): CalibrationEngine {
    engine.current?.cancel();
    const applied = engine.current?.applied ?? null;
    const next = new CalibrationEngine({
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
        await postForm('/api/settings/audio', {
          line: String(o.line),
          gain: String(o.gain),
          atten: String(atten),
        });
      },
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (text, cls = '') => setLog((lines) => [...lines, { text, cls }]),
      levels: (s) => setLive({ rms: s.rms, peak: s.peak }),
      silenceProgress: (fraction, rms) => {
        setProgress(fraction);
        setFloorText(rms ? dbfs(rms) : '−∞');
      },
    });
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
          text: `Still clipping at ${CAL_ATTEN_MAX} dB — turn the source volume down, then go Back and retry.`,
          cls: '',
        },
      ]);
      return;
    }
    setResult({ atten: outcome.atten, peakDb: outcome.peakDb });
    // The calibrated value is already live on the device; refresh the audio form.
    loadConfig().catch(() => {});
    show(4);
  }

  function show(next: number) {
    engine.current?.cancel();
    setStep(next);
    if (next === 2) runSilence();
    if (next === 3) runLoud();
  }

  async function close(restore: boolean) {
    engine.current?.cancel();
    const applied = engine.current?.applied ?? null;
    const o = original.current;
    onClose();
    if (restore && applied !== null && applied !== o.atten) {
      try {
        await postForm('/api/settings/audio', {
          line: String(o.line),
          gain: String(o.gain),
          atten: String(o.atten),
        });
        toast(`Put ADC attenuation back to ${o.atten} dB`, 'ok');
        loadConfig().catch(() => {});
      } catch (error) {
        toast(
          `Could not restore previous levels: ${error instanceof Error ? error.message : error}`,
          'err',
        );
      }
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
      ]
    : [];

  return (
    <div class="overlay">
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Level calibration">
        <div class="stepline">
          LEVEL CALIBRATION
          <span class="stepdots">
            {[1, 2, 3, 4].map((i) => (
              <i key={i} class={i <= step ? 'on' : ''} />
            ))}
          </span>
        </div>

        {step === 1 && (
          <div>
            <h3>Calibrate input levels</h3>
            <div class="body">
              <p>
                StreamLine measures your source and picks the ADC attenuation for you. Takes about a
                minute. You’ll need:
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
                Levels change live while it runs — streaming keeps going. Cancelling puts your
                current settings back.
              </p>
            </div>
          </div>
        )}

        {step === 2 && (
          <div>
            <h3>First, measure the quiet</h3>
            <div class="body">
              <p>
                Leave everything connected, but pause playback on your source. StreamLine listens
                for a few seconds to learn its idle level.
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
        )}

        {step === 3 && (
          <div>
            <h3>Now play the loudest track you have</h3>
            <div class="body">
              <p>
                Starting from 0 dB, StreamLine raises the attenuation until loud passages stop
                clipping.
              </p>
            </div>
            <div class="meter">
              <div class="meterrow">
                <span class="chn">In</span>
                <div class="track">
                  <div class="zones" />
                  <div
                    class="fill"
                    style={{ clipPath: `inset(0 ${100 - meterPct(live.rms)}% 0 0)` }}
                  />
                  <div class="peakhold" style={{ left: `calc(${meterPct(live.peak)}% - 1px)` }} />
                </div>
              </div>
            </div>
            <div class="log wizlog">
              {log.map((line, i) => (
                <div key={i} class={line.cls}>
                  {line.text}
                </div>
              ))}
            </div>
          </div>
        )}

        {step === 4 && result && (
          <div>
            <h3>Calibrated</h3>
            <div class="body">
              <p>
                {result.atten === original.current.atten
                  ? 'Your current setting was already right — nothing changed.'
                  : 'Applied and saved — the device is already running with the new setting.'}
              </p>
            </div>
            <Kv rows={doneRows} />
          </div>
        )}

        <div class="sheetfoot">
          <button class="btn secondary" type="button" onClick={() => close(true)}>
            {step === 4 ? 'Undo & close' : 'Cancel'}
          </button>
          <div class="row">
            {step > 1 && step < 4 && (
              <button class="btn secondary" type="button" onClick={() => show(step - 1)}>
                Back
              </button>
            )}
            {step !== 3 && (
              <button
                class="btn primary"
                type="button"
                disabled={step === 2 && !floorOk && !silenceNote}
                onClick={() => {
                  if (step === 1) show(2);
                  else if (step === 2) show(floorOk ? 3 : 2);
                  else if (step === 4) close(false);
                }}
              >
                {step === 1
                  ? 'Start'
                  : step === 2
                    ? silenceNote
                      ? 'Measure again'
                      : 'Continue'
                    : 'Done'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
