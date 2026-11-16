import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setTransport } from '../../src/device/lib/http';
import { deviceStatus } from '../../src/device/mocks/fixtures';
import {
  connection,
  deliveryObserved,
  readBack,
  refresh,
  status,
} from '../../src/device/state/device';
import type { StatusResponse } from '../../src/generated/api';
import { answering } from './answering';

/** A device whose status answers wait until the test lets each one go. */
function slowDevice() {
  const waiting: Array<(status: StatusResponse) => void> = [];
  setTransport(
    () =>
      new Promise((answer) => {
        waiting.push((next) => answer(Response.json(next)));
      }),
  );
  return {
    get asked() {
      return waiting.length;
    },
    answer(index: number, next: StatusResponse) {
      waiting[index](next);
    },
  };
}

/** Let queued promise callbacks run, so a request the code sends next is on its way. */
const settle = () => new Promise((done) => setTimeout(done));

describe('status reads', () => {
  beforeEach(() => answering(deviceStatus()));
  afterEach(() => setTransport((request) => fetch(request)));

  it('shares one poll between callers while it runs', async () => {
    const device = slowDevice();
    const first = refresh();
    const second = refresh();
    await settle();
    expect(device.asked).toBe(1);
    device.answer(0, deviceStatus());
    await Promise.all([first, second]);
  });

  it('reads back after a poll that was already on its way', async () => {
    const device = slowDevice();
    const before = deviceStatus();
    const after = {
      ...before,
      audio: { ...before.audio, input_gain: before.audio.input_gain + 4 },
    };
    void refresh();
    const read = readBack();
    await settle();
    device.answer(0, before);
    await settle();
    expect(device.asked).toBe(2);
    device.answer(1, after);
    await read;
    expect(status.value?.audio.input_gain).toBe(after.audio.input_gain);
  });
});

/** A device that gives these answers in turn; null leaves a read unanswered. */
function answersInTurn(...answers: Array<object | null>): void {
  setTransport(async () => {
    const next = answers.shift();
    if (!next) throw new TypeError('Failed to fetch');
    return Response.json(next);
  });
}

describe('an answer after a lost read', () => {
  const mine = deviceStatus();
  const { boot: _boot, ...noBoot } = mine.system;
  beforeEach(() => answering(mine));
  afterEach(() => setTransport((request) => fetch(request)));

  it('from another image hands the page to that image', async () => {
    // An image older than the running slot and the boot id, as a rollback can reach.
    const { running_slot: _slot, ...older } = mine.ota;
    answersInTurn(mine, null, { ...mine, ota: older, system: noBoot });
    for (let read = 0; read < 3; read += 1) await refresh();
    expect(connection.value.phase).toBe('replaced');
  });

  it('compares delivery with no count it lost', async () => {
    answersInTurn(mine, null, { ...mine, system: noBoot });
    for (let read = 0; read < 3; read += 1) await refresh();
    expect(connection.value.phase).toBe('live');
    expect(deliveryObserved.value).toBe(false);
  });
});
