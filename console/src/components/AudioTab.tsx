import { useEffect, useState } from 'preact/hooks';
import { setAudio } from '../lib/api';
import { useTransact, useWritable } from '../lib/hooks';
import { config, loadDeviceSettings, status } from '../state/device';
import { AnalogPassthrough } from './AnalogPassthrough';
import { AudioProfiles } from './AudioProfiles';
import { Card, CardFooter } from './Card';
import { GuidePrompt } from './GuidePrompt';
import { Meter } from './Meter';
import { ActionState, TransactButton } from './Transact';

export function AudioTab({ onCalibrate }: { onCalibrate: () => void }) {
  const writable = useWritable();
  const transact = useTransact();
  // Board facts come from the device; the console hardcodes none of them.
  const caps = status.value?.capabilities;
  const [line, setLine] = useState('2');
  const [gain, setGain] = useState('0');
  const [atten, setAtten] = useState('0');

  // Seed the form whenever a fresh settings snapshot arrives (initial load
  // and after every expected reboot).
  const c = config.value;
  useEffect(() => {
    if (!c) return;
    setLine(String(c.input_line));
    setGain(String(c.input_gain));
    setAtten(String(c.adc_attenuation_db));
  }, [c]);

  function save(e: SubmitEvent) {
    e.preventDefault();
    transact.run(
      async () => {
        const ack = await setAudio({
          input_line: Number(line),
          input_gain: Number(gain),
          adc_attenuation_db: Number(atten),
        });
        if (!ack.rebooting) await loadDeviceSettings();
        return ack;
      },
      {
        busyText: 'Saving…',
        okText: 'Saved — the meter shows the new levels',
        // In setup mode the codec is not running, so the device restarts instead.
        reboots: 'the audio settings',
      },
    );
  }

  return (
    <>
      <AudioProfiles />
      <Card
        gated
        title="Input settings"
        lead="Changes apply instantly and return to Custom settings. Watch the live level below."
      >
        <GuidePrompt
          text="Not sure about levels? A guide measures your source and sets these."
          action="Calibrate levels"
          disabled={!writable}
          onAction={onCalibrate}
        />
        <form onSubmit={save}>
          <div class="formgrid">
            <div class="field">
              <label for="input_line">Source line</label>
              <select
                id="input_line"
                disabled={!writable}
                value={line}
                onChange={(e) => setLine(e.currentTarget.value)}
              >
                {(caps?.input_lines ?? []).map((option) => (
                  <option key={option.line} value={String(option.line)}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div class="field">
              <label for="input_gain">Input gain</label>
              <div class="unit">
                <input
                  id="input_gain"
                  type="number"
                  min="0"
                  max={caps?.input_gain_max}
                  disabled={!writable}
                  value={gain}
                  onInput={(e) => setGain(e.currentTarget.value)}
                />
                <span class="u">/ {caps?.input_gain_max ?? '—'}</span>
              </div>
              <span class="help">Leave at 0 for line-level sources.</span>
            </div>
            <div class="field">
              <label for="adc_atten_db">ADC attenuation</label>
              <div class="unit">
                <input
                  id="adc_atten_db"
                  type="number"
                  min="0"
                  max={caps?.adc_atten_max_db}
                  disabled={!writable}
                  value={atten}
                  onInput={(e) => setAtten(e.currentTarget.value)}
                />
                <span class="u">dB</span>
              </div>
              <span class="help">Raise until loud passages stop clipping.</span>
            </div>
          </div>
          <CardFooter>
            <TransactButton transact={transact} type="submit" disabled={!writable}>
              Save
            </TransactButton>
            <ActionState state={transact.state} />
          </CardFooter>
        </form>
        {status.value && (
          <AnalogPassthrough
            capability={caps?.analog_passthrough}
            status={status.value.analog_passthrough}
            writable={writable}
            provisioned={status.value.mode === 'provisioned'}
          />
        )}
      </Card>

      <Card title="Live level" lead="Watch the effect of a change here. Clipping lights the lamp.">
        <Meter />
      </Card>
    </>
  );
}
