import { signal } from '@preact/signals';
import {
  type BridgeStatus,
  createRecordingDownloadTicket,
  type DownloadTicket,
  deleteRecording,
  deleteTransportKey,
  getBridgeStatus,
  getRecordingCapabilities,
  getRecordings,
  putTransportKey,
  type RecordingCapabilities,
  type RecordingList,
  type StartRecordingRequest,
  setTransportMode,
  startRecording,
  stopRecording,
  type TransportModeRequestMode,
  unlockBridge,
} from '../generated/bridge';
import {
  bridgeToken,
  forgetBridgeToken,
  rememberBridgeToken,
  setAuthRejectedHandler,
} from './http';

export interface BridgeApi {
  status(): Promise<BridgeStatus>;
  capabilities(): Promise<RecordingCapabilities>;
  recordings(): Promise<RecordingList>;
  start(request: StartRecordingRequest): Promise<void>;
  stop(id: string): Promise<void>;
  delete(id: string): Promise<void>;
  ticket(id: string): Promise<DownloadTicket>;
  unlock(): Promise<void>;
  setTransportMode(mode: TransportModeRequestMode): Promise<void>;
  putTransportKey(keyId: string, psk: string): Promise<void>;
  deleteTransportKey(keyId: string): Promise<void>;
}

export type Scheduler = (callback: () => void, delay: number) => number;

/**
 * One lock for the whole bridge console. `no-token` means the deployment has
 * no bridge API token yet, so there is nothing to unlock with.
 */
export type BridgeAccess = 'checking' | 'no-token' | 'locked' | 'unlocked';

const runtimeApi: BridgeApi = {
  status: getBridgeStatus,
  capabilities: getRecordingCapabilities,
  recordings: getRecordings,
  start: async (request) => {
    await startRecording(request);
  },
  stop: async (id) => {
    await stopRecording(id);
  },
  delete: async (id) => {
    await deleteRecording(id);
  },
  ticket: createRecordingDownloadTicket,
  unlock: async () => {
    await unlockBridge();
  },
  setTransportMode: async (mode) => {
    await setTransportMode({ mode });
  },
  putTransportKey: async (keyId, psk) => {
    await putTransportKey(keyId, { psk });
  },
  deleteTransportKey: async (keyId) => {
    await deleteTransportKey(keyId);
  },
};

export class BridgeController {
  readonly status = signal<BridgeStatus>();
  readonly capabilities = signal<RecordingCapabilities>();
  readonly recordings = signal<RecordingList>();
  readonly unreachable = signal(false);
  /** When the last successful status poll landed; drives the stale-age hint. */
  readonly statusAt = signal(0);
  readonly access = signal<BridgeAccess>('checking');
  readonly error = signal('');
  /** Load failures per resource, so each renders its own named retry. */
  readonly capabilitiesError = signal('');
  readonly recordingsError = signal('');
  /** One recording mutation at a time; a second click is ignored in flight. */
  private actionInFlight = false;

  private recordingTimer?: number;
  private statusTimer?: number;

  constructor(
    private readonly api: BridgeApi = runtimeApi,
    // Wrapped so the browser sees `window` as the receiver: a bare
    // `window.setTimeout` reference invoked through `this.schedule` throws
    // "called on an object that does not implement interface Window" and
    // silently ends the poll loop after its first tick.
    private readonly schedule: Scheduler = (callback, delay) => window.setTimeout(callback, delay),
    private readonly cancel: (id: number) => void = (id) => window.clearTimeout(id),
    private readonly storedToken: () => string = bridgeToken,
  ) {}

  start(): void {
    // A rejected authenticated request anywhere is one lock transition:
    // the transport already forgot the token; drop private state here.
    setAuthRejectedHandler(() => this.lock());
    void this.pollStatus();
    void this.loadCapabilities();
    if (this.storedToken()) void this.resume();
  }

  stop(): void {
    if (this.statusTimer !== undefined) this.cancel(this.statusTimer);
    if (this.recordingTimer !== undefined) this.cancel(this.recordingTimer);
  }

  async pollStatus(): Promise<void> {
    try {
      this.status.value = await this.api.status();
      if (!this.status.value.api_token_configured) {
        this.access.value = 'no-token';
      } else if (this.access.value === 'checking' || this.access.value === 'no-token') {
        this.access.value = 'locked';
      }
      this.unreachable.value = false;
      this.statusAt.value = Date.now();
    } catch {
      this.unreachable.value = true;
    } finally {
      this.statusTimer = this.schedule(() => void this.pollStatus(), 1000);
    }
  }

  async loadCapabilities(): Promise<void> {
    try {
      this.capabilities.value = await this.api.capabilities();
      this.capabilitiesError.value = '';
      await this.maybeLoadRecordings();
    } catch (error) {
      this.capabilitiesError.value = message(error);
    }
  }

  /** Validate the token against the bridge before showing anything unlocked. */
  async unlock(token: string): Promise<void> {
    rememberBridgeToken(token.trim());
    try {
      await this.api.unlock();
      this.access.value = 'unlocked';
      this.error.value = '';
      await this.maybeLoadRecordings();
    } catch (error) {
      forgetBridgeToken();
      if (this.access.value !== 'no-token') this.access.value = 'locked';
      this.error.value = message(error);
      throw error;
    }
  }

  lock(): void {
    forgetBridgeToken();
    if (this.recordingTimer !== undefined) this.cancel(this.recordingTimer);
    this.recordingTimer = undefined;
    this.recordings.value = undefined;
    if (this.access.value === 'unlocked') this.access.value = 'locked';
  }

  /** Switch the PCM listener; a change drops live producers on the bridge. */
  async setEncryption(enabled: boolean): Promise<boolean> {
    try {
      await this.api.setTransportMode(enabled ? 'tls-psk' : 'cleartext');
      await this.pollStatusOnce();
      this.error.value = '';
      return true;
    } catch (error) {
      this.error.value = message(error);
      return false;
    }
  }

  async provisionTransportKey(keyId: string, psk: string): Promise<boolean> {
    try {
      await this.api.putTransportKey(keyId, psk);
      await this.pollStatusOnce();
      this.error.value = '';
      return true;
    } catch (error) {
      this.error.value = message(error);
      return false;
    }
  }

  async removeTransportKey(keyId: string): Promise<boolean> {
    try {
      await this.api.deleteTransportKey(keyId);
      await this.pollStatusOnce();
      this.error.value = '';
      return true;
    } catch (error) {
      this.error.value = message(error);
      return false;
    }
  }

  /** Returns true when the list is now current. */
  async refreshRecordings(): Promise<boolean> {
    try {
      this.updateRecordings(await this.api.recordings());
      this.recordingsError.value = '';
      return true;
    } catch (error) {
      this.recordingsError.value = message(error);
      if (this.recordings.value?.active.length) this.scheduleRecordingRefresh();
      return false;
    }
  }

  async startRecording(request: StartRecordingRequest): Promise<MutationOutcome> {
    return this.runRecordingAction(() => this.api.start(request));
  }

  async stopRecording(id: string): Promise<MutationOutcome> {
    return this.runRecordingAction(() => this.api.stop(id));
  }

  async deleteRecording(id: string): Promise<MutationOutcome> {
    return this.runRecordingAction(() => this.api.delete(id));
  }

  async downloadTicket(id: string): Promise<DownloadTicket | undefined> {
    try {
      const ticket = await this.api.ticket(id);
      this.error.value = '';
      return ticket;
    } catch (error) {
      this.error.value = message(error);
      return undefined;
    }
  }

  /** Re-enter the unlocked state with a token this browser tab already holds. */
  private async resume(): Promise<void> {
    try {
      await this.api.unlock();
      this.access.value = 'unlocked';
      await this.maybeLoadRecordings();
    } catch {
      forgetBridgeToken();
    }
  }

  private async maybeLoadRecordings(): Promise<void> {
    if (this.access.value === 'unlocked' && this.capabilities.value?.enabled) {
      await this.refreshRecordings();
    }
  }

  private updateRecordings(recordings: RecordingList): void {
    if (this.recordingTimer !== undefined) this.cancel(this.recordingTimer);
    this.recordingTimer = undefined;
    this.recordings.value = recordings;
    if (recordings.active.length > 0) this.scheduleRecordingRefresh();
  }

  private async pollStatusOnce(): Promise<void> {
    this.status.value = await this.api.status();
    this.unreachable.value = false;
  }

  private scheduleRecordingRefresh(): void {
    if (this.recordingTimer !== undefined) this.cancel(this.recordingTimer);
    this.recordingTimer = this.schedule(() => void this.refreshRecordings(), 1000);
  }

  private async runRecordingAction(action: () => Promise<void>): Promise<MutationOutcome> {
    if (this.actionInFlight) return 'in-flight';
    this.actionInFlight = true;
    try {
      await action();
    } catch (error) {
      this.error.value = message(error);
      return 'failed';
    } finally {
      this.actionInFlight = false;
    }
    this.error.value = '';
    // The bridge accepted the mutation; a refresh failure must not be
    // reported as the mutation failing.
    return (await this.refreshRecordings()) ? 'done' : 'refresh-failed';
  }
}

/**
 * How a recording mutation ended: `done` means applied and the list is
 * current, `refresh-failed` means applied but the list is stale, `failed`
 * means the bridge rejected it, `in-flight` means an earlier one still runs.
 */
export type MutationOutcome = 'done' | 'refresh-failed' | 'failed' | 'in-flight';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
