import { signal } from '@preact/signals';
import {
  type BridgeStatus,
  createRecordingDownloadTicket,
  type DownloadTicket,
  deleteRecording,
  getBridgeStatus,
  getRecordingCapabilities,
  getRecordings,
  type RecordingCapabilities,
  type RecordingList,
  type StartRecordingRequest,
  startRecording,
  stopRecording,
} from '../generated/bridge';
import { forgetRecordingToken, rememberRecordingToken } from './http';

export interface BridgeApi {
  status(): Promise<BridgeStatus>;
  capabilities(): Promise<RecordingCapabilities>;
  recordings(): Promise<RecordingList>;
  start(request: StartRecordingRequest): Promise<void>;
  stop(id: string): Promise<void>;
  delete(id: string): Promise<void>;
  ticket(id: string): Promise<DownloadTicket>;
}

export type Scheduler = (callback: () => void, delay: number) => number;

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
};

export class BridgeController {
  readonly status = signal<BridgeStatus>();
  readonly capabilities = signal<RecordingCapabilities>();
  readonly recordings = signal<RecordingList>();
  readonly unreachable = signal(false);
  readonly recordingState = signal<'checking' | 'disabled' | 'locked' | 'unlocked'>('checking');
  readonly error = signal('');

  private recordingTimer?: number;
  private statusTimer?: number;

  constructor(
    private readonly api: BridgeApi = runtimeApi,
    private readonly schedule: Scheduler = window.setTimeout,
    private readonly cancel: (id: number) => void = window.clearTimeout,
  ) {}

  start(): void {
    void this.pollStatus();
    void this.loadCapabilities();
  }

  stop(): void {
    if (this.statusTimer !== undefined) this.cancel(this.statusTimer);
    if (this.recordingTimer !== undefined) this.cancel(this.recordingTimer);
  }

  async pollStatus(): Promise<void> {
    try {
      this.status.value = await this.api.status();
      this.unreachable.value = false;
    } catch {
      this.unreachable.value = true;
    } finally {
      this.statusTimer = this.schedule(() => void this.pollStatus(), 1000);
    }
  }

  async loadCapabilities(): Promise<void> {
    try {
      const capabilities = await this.api.capabilities();
      this.capabilities.value = capabilities;
      this.recordingState.value = capabilities.enabled ? 'locked' : 'disabled';
    } catch (error) {
      this.error.value = message(error);
    }
  }

  async unlock(token: string): Promise<void> {
    rememberRecordingToken(token);
    try {
      const recordings = await this.api.recordings();
      this.recordingState.value = 'unlocked';
      this.error.value = '';
      this.updateRecordings(recordings);
    } catch (error) {
      forgetRecordingToken();
      this.recordingState.value = 'locked';
      this.error.value = message(error);
      throw error;
    }
  }

  lock(): void {
    forgetRecordingToken();
    if (this.recordingTimer !== undefined) this.cancel(this.recordingTimer);
    this.recordingTimer = undefined;
    this.recordings.value = undefined;
    this.recordingState.value = 'locked';
  }

  async refreshRecordings(): Promise<void> {
    try {
      this.updateRecordings(await this.api.recordings());
    } catch (error) {
      this.error.value = message(error);
      if (this.recordings.value?.active.length) this.scheduleRecordingRefresh();
    }
  }

  async startRecording(request: StartRecordingRequest): Promise<boolean> {
    return this.runRecordingAction(() => this.api.start(request));
  }

  async stopRecording(id: string): Promise<boolean> {
    return this.runRecordingAction(() => this.api.stop(id));
  }

  async deleteRecording(id: string): Promise<boolean> {
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

  private updateRecordings(recordings: RecordingList): void {
    if (this.recordingTimer !== undefined) this.cancel(this.recordingTimer);
    this.recordingTimer = undefined;
    this.recordings.value = recordings;
    if (recordings.active.length > 0) this.scheduleRecordingRefresh();
  }

  private scheduleRecordingRefresh(): void {
    if (this.recordingTimer !== undefined) this.cancel(this.recordingTimer);
    this.recordingTimer = this.schedule(() => void this.refreshRecordings(), 1000);
  }

  private async runRecordingAction(action: () => Promise<void>): Promise<boolean> {
    try {
      await action();
      await this.refreshRecordings();
      this.error.value = '';
      return true;
    } catch (error) {
      this.error.value = message(error);
      return false;
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
