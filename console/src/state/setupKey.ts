/**
 * The admin key generated for first-time setup. It exists only while the
 * device has no key of its own (`auth_required: false`) and is shown once.
 */

import { effect, signal } from '@preact/signals';
import { generateAdminKey } from '../lib/adminKey';
import { status } from './device';

export const setupKey = signal('');

effect(() => {
  const s = status.value;
  if (!s) return;
  if (s.auth_required) {
    setupKey.value = '';
  } else if (!setupKey.value) {
    setupKey.value = generateAdminKey();
  }
});
