/**
 * Writes on Device → Hardware that apply without a restart: the name and
 * what each button and LED does. Each needs the admin key and resolves null
 * when the owner declines to unlock; afterwards the console reads back where
 * the device reports the change, so a row shows what the device holds.
 */

import * as v from 'valibot';
import {
  type Ack,
  type ButtonAction,
  type LedRole,
  setButton,
  setLed,
  setName,
} from '../../generated/api';
import { NameSettingsRequest as nameRule } from '../../generated/rules';
import { readAgain } from '../../shared/queries';
import { withAccess } from './access';
import { readBack } from './device';
import { settingsQuery } from './queries';

async function settingsWrite(write: () => Promise<Ack>): Promise<Ack | null> {
  const done = await withAccess(write);
  if (done) await readAgain(settingsQuery);
  return done;
}

export function assignButton(id: string, action: ButtonAction): Promise<Ack | null> {
  return settingsWrite(() => setButton({ id, action }));
}

export function assignLed(id: string, role: LedRole): Promise<Ack | null> {
  return settingsWrite(() => setLed({ id, role }));
}

/** Why the contract refuses `value` as the device's name, or null. */
export function nameProblem(value: string): string | null {
  return v.is(nameRule.entries.name, value.trim()) ? null : 'A name has at most 32 characters.';
}

/** The status carries the name to the rail and the tab, so the write reads it back. */
export async function renameDevice(name: string): Promise<Ack | null> {
  const done = await withAccess(() => setName({ name: name.trim() }));
  if (done) await readBack();
  return done;
}
