import type { StatusResponse } from '../../src/device/lib/api';
import { connection } from '../../src/device/state/device';

/** The device just answered with `status`; null means nothing has answered yet. */
export function answering(status: StatusResponse | null): void {
  connection.value = status
    ? { phase: 'live', seen: { status, at: Date.now() } }
    : { phase: 'opening' };
}
