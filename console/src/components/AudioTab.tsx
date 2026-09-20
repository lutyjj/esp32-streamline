import { setAudio } from '../lib/api';
import { useDeviceField, useTransact, useWritable } from '../lib/hooks';
import { clipCalloutVisible, dismissClipCallout } from '../state/clipCallout';
import { audioProfilesResource, contractResource, status } from '../state/device';
import { lossCalloutVisible } from '../state/streamLoss';
import { AnalogPassthrough } from './AnalogPassthrough';
import { AudioDelivery } from './AudioDelivery';
import { AudioProfiles } from './AudioProfiles';
import { Button } from './Button';
import { Disclosure } from './Disclosure';
import { FieldFlag } from './FieldFlag';
import { Kv } from './Kv';
import { Meter } from './Meter';
import { Notice } from './Notice';
import { ResourceNotice } from './ResourceNotice';
import { Section, SectionActions } from './Section';
import { ActionState, TransactButton } from './Transact';

export function AudioTab({
  onCalibrate,
  onSetupBridge,
}: {
  onCalibrate: () => void;
  onSetupBridge: () => void;
}) {
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
        okText: 'Input settings applied',
        // In setup mode the codec is not running, so the device restarts instead.
        reboots: 'the audio settings',
      },
    );
  }

  const inputLabel =
    caps?.input_lines.find((input) => input.line === audio?.input_line)?.label ?? 'Audio input';
  return (
    <>
      <ResourceNotice of={audioProfilesResource} />
      <ResourceNotice of={contractResource} />
      <div class="audio-workspace">
        <div class="audio-monitor">
          <div class="monitor-heading">
            <h2>{inputLabel}</h2>
            <span>Live input</span>
          </div>
          <Meter foot />
          <AudioDelivery onSetupBridge={onSetupBridge} />
          {lossCalloutVisible.value && (
            <Notice tone="error">
              Audio packets are being dropped. Check the Wi-Fi link and bridge; listeners may hear
              gaps.
            </Notice>
          )}
          {clipCalloutVisible.value && (
            <Notice tone="warn">
              <strong>Loud passages are clipping.</strong> Adjust the levels or run calibration.
              <div class="actions">
                <Button disabled={!writable} onClick={onCalibrate}>
                  Calibrate levels
                </Button>
                <Button onClick={dismissClipCallout}>Dismiss</Button>
              </div>
            </Notice>
          )}
          <Disclosure title="Signal details">
            <Kv
              rows={
                s
                  ? [
                      ['Packets sent', String(s.metrics.packets_total)],
                      ['Dropped packets', String(s.metrics.queue_drops_total)],
                      ['Send errors', String(s.metrics.network_errors_total)],
                      ['Reconnects', String(s.metrics.reconnects_total)],
                    ]
                  : []
              }
            />
          </Disclosure>
        </div>
        <div class="audio-controls">
          <Section gated title="Adjust input" lead="Changes apply when you save.">
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
              <SectionActions>
                <TransactButton transact={transact} type="submit" disabled={!writable || !dirty}>
                  Save
                </TransactButton>
                <ActionState state={transact.state} />
              </SectionActions>
            </form>

            <div class="calibration-entry">
              <div>
                <strong>Let StreamLine set the levels</strong>
                <p>Play a loud passage. The guide measures your source and checks the result.</p>
              </div>
              <Button disabled={!writable} onClick={onCalibrate}>
                Calibrate input
              </Button>
            </div>
          </Section>
        </div>
      </div>
      <div class="audio-library">
        {' '}
        <AudioProfiles
          draftPending={
            dirty ||
            transact.busy ||
            (audio !== null &&
              (line.value !== String(audio.input_line) ||
                gain.value !== String(audio.input_gain) ||
                atten.value !== String(audio.adc_attenuation_db)))
          }
        />{' '}
        {s && (
          <AnalogPassthrough
            capability={caps?.analog_passthrough}
            status={s.analog_passthrough}
            writable={writable}
            provisioned={s.mode === 'provisioned'}
          />
        )}
      </div>
    </>
  );
}
