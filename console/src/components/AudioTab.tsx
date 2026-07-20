import { setAudio } from '../lib/api';
import { useDeviceField, useTransact, useWritable } from '../lib/hooks';
import { audioProfilesResource, contractResource, status } from '../state/device';
import { AnalogPassthrough } from './AnalogPassthrough';
import { AudioProfiles } from './AudioProfiles';
import { Card, CardFooter } from './Card';
import { FieldFlag } from './FieldFlag';
import { GuidePrompt } from './GuidePrompt';
import { ResourceNotice } from './ResourceNotice';
import { ActionState, TransactButton } from './Transact';

export function AudioTab({ onCalibrate }: { onCalibrate: () => void }) {
  const writable = useWritable();
  const transact = useTransact();
  const s = status.value;
  // Board facts and the applied levels come from the device; the console
  // hardcodes none of them. Sourcing the controls from the live status poll —
  // not the once-read settings snapshot — is what lets a board button or
  // another client move them under the user within a poll.
  const caps = s?.capabilities;
  const audio = s?.audio ?? null;
  const line = useDeviceField(audio ? String(audio.input_line) : null);
  const gain = useDeviceField(audio ? String(audio.input_gain) : null);
  const atten = useDeviceField(audio ? String(audio.adc_attenuation_db) : null);
  const dirty = line.dirty || gain.dirty || atten.dirty;

  function save(e: SubmitEvent) {
    e.preventDefault();
    transact.run(
      async () => {
        const ack = await setAudio({
          input_line: Number(line.value),
          input_gain: Number(gain.value),
          adc_attenuation_db: Number(atten.value),
        });
        // A live save applies at once: mark the fields clean so the confirming
        // poll reads as steady, not a fresh device change. A reboot re-seeds
        // them on recovery instead.
        if (!ack.rebooting) {
          line.commit();
          gain.commit();
          atten.commit();
        }
        return ack;
      },
      {
        busyText: 'Saving…',
        okText: 'Saved — the Overview meter shows the new levels',
        // In setup mode the codec is not running, so the device restarts instead.
        reboots: 'the audio settings',
      },
    );
  }

  return (
    <>
      <ResourceNotice of={audioProfilesResource} />
      <ResourceNotice of={contractResource} />
      <AudioProfiles />
      <Card
        gated
        title="Input settings"
        lead="Changes apply instantly and return to Custom settings. The Overview shows the live input level."
      >
        <GuidePrompt
          text="Not sure? The guide measures your source and sets everything for you."
          action="Guide me"
          disabled={!writable}
          onAction={onCalibrate}
        />
        <form onSubmit={save}>
          <div class="formgrid">
            <div class="field">
              <label for="input_line">
                Source line
                <FieldFlag field={line} />
              </label>
              <select
                id="input_line"
                disabled={!writable}
                value={line.value}
                onChange={(e) => line.set(e.currentTarget.value)}
              >
                {(caps?.input_lines ?? []).map((option) => (
                  <option key={option.line} value={String(option.line)}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div class="field">
              <label for="input_gain">
                Input gain
                <FieldFlag field={gain} />
              </label>
              <div class="unit">
                <input
                  id="input_gain"
                  type="number"
                  min="0"
                  max={caps?.input_gain_max}
                  disabled={!writable}
                  value={gain.value}
                  onInput={(e) => gain.set(e.currentTarget.value)}
                />
                <span class="u">/ {caps?.input_gain_max ?? '—'}</span>
              </div>
              <span class="help">Leave at 0 for line-level sources.</span>
            </div>
            <div class="field">
              <label for="adc_atten_db">
                ADC attenuation
                <FieldFlag field={atten} />
              </label>
              <div class="unit">
                <input
                  id="adc_atten_db"
                  type="number"
                  min="0"
                  max={caps?.adc_atten_max_db}
                  disabled={!writable}
                  value={atten.value}
                  onInput={(e) => atten.set(e.currentTarget.value)}
                />
                <span class="u">dB</span>
              </div>
              <span class="help">Raise until loud passages stop clipping.</span>
            </div>
          </div>
          <CardFooter>
            <TransactButton transact={transact} type="submit" disabled={!writable || !dirty}>
              Save
            </TransactButton>
            <ActionState state={transact.state} />
          </CardFooter>
        </form>
        {s && (
          <AnalogPassthrough
            capability={caps?.analog_passthrough}
            status={s.analog_passthrough}
            writable={writable}
            provisioned={s.mode === 'provisioned'}
          />
        )}
      </Card>
    </>
  );
}
