import { useEffect, useState } from 'preact/hooks';
import { postForm } from '../lib/api';
import { useTransact, useWritable } from '../lib/hooks';
import { config } from '../state/device';
import { Meter } from './Meter';

export function AudioTab({ onCalibrate }: { onCalibrate: () => void }) {
  const writable = useWritable();
  const transact = useTransact();
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
    setAtten(String(c.adc_atten_db));
  }, [c]);

  function save(e: SubmitEvent) {
    e.preventDefault();
    transact.run(() => postForm('/api/settings/audio', { line, gain, atten }), {
      busyText: 'Saving…',
      okText: 'Saved — the meter shows the new levels',
      // In setup mode the codec is not running, so the device restarts instead.
      reboots: 'the audio settings',
    });
  }

  return (
    <>
      <div class="card gated">
        <span class="lockhint">Unlock to edit</span>
        <h2>Input</h2>
        <p class="lead">
          Changes apply instantly while the device keeps running — watch the live level below.
        </p>
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
                <option value="2">Line 2 — 3.5 mm jack</option>
                <option value="1">Line 1 — header pins</option>
              </select>
            </div>
            <div class="field">
              <label for="input_gain">Input gain</label>
              <div class="unit">
                <input
                  id="input_gain"
                  type="number"
                  min="0"
                  max="100"
                  disabled={!writable}
                  value={gain}
                  onInput={(e) => setGain(e.currentTarget.value)}
                />
                <span class="u">/ 100</span>
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
                  max="48"
                  disabled={!writable}
                  value={atten}
                  onInput={(e) => setAtten(e.currentTarget.value)}
                />
                <span class="u">dB</span>
              </div>
              <span class="help">Raise until loud passages stop clipping.</span>
            </div>
            <div class="field">
              <label for="calibrateButton">Not sure?</label>
              <button
                class="btn secondary"
                type="button"
                id="calibrateButton"
                style="justify-self:start"
                disabled={!writable}
                onClick={onCalibrate}
              >
                Calibrate levels…
              </button>
              <span class="help">Measures your source and sets these for you.</span>
            </div>
          </div>
          <div class="cardfoot">
            <button
              class={`btn primary${transact.busy ? ' busy' : ''}`}
              type="submit"
              disabled={!writable || transact.busy}
            >
              <span class="spin" />
              Save
            </button>
            <span class={`actionstate ${transact.state.cls}`}>{transact.state.text}</span>
          </div>
        </form>
      </div>

      <div class="card">
        <h2>Live level</h2>
        <p class="lead">Watch the effect of a change here — clipping lights the lamp.</p>
        <Meter />
      </div>
    </>
  );
}
