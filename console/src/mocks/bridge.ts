/**
 * In-memory fake bridge behind the generated bridge API. One state model
 * backs status, transport, and recordings; authorization follows the
 * contract's `SECURED_OPERATIONS` exactly as `bridgeFetch` sends it.
 * `tests/mockCoverage.test.ts` pins the handler set to
 * `docs/bridge-openapi.json`.
 */

import { type HttpHandler, HttpResponse, http, type JsonBodyType } from 'msw';
import { operationSecured } from '../bridge/http';
import type {
  BridgeStatus,
  RecordingCapabilities,
  RecordingList,
  RecordingSnapshot,
  StartRecordingRequest,
  TransportKeyRequest,
  TransportModeRequest,
} from '../generated/bridge';
import { bridgeStatus, recordingCapabilities, sourceSnapshot } from './fixtures';

/** The API token the fake bridge accepts. */
export const MOCK_BRIDGE_TOKEN = 'mock-bridge-token';

/** Credential-ID and PSK shapes the real bridge enforces. */
const KEY_ID_PATTERN = /^eli1-[0-9a-f]{32}$/;
const PSK_PATTERN = /^[0-9a-f]{64}$/;

export class FakeBridge {
  readonly handlers: HttpHandler[];
  private status: BridgeStatus;
  private capabilities: RecordingCapabilities;
  private active: RecordingSnapshot[] = [];
  private saved: RecordingSnapshot[] = [];
  private recordingSerial = 0;

  constructor() {
    this.status = bridgeStatus({ sources: { '192.0.2.10': sourceSnapshot() } });
    this.capabilities = recordingCapabilities();
    this.handlers = [
      this.handle('get', '/health', () => new HttpResponse('ok')),
      this.handle('get', '/status', () => this.statusResponse()),
      this.handle('get', '/streamline.wav', () => silentWav()),
      this.handle('get', '/api/transport', () => this.status.transport),
      this.handle<TransportModeRequest>('put', '/api/transport/mode', (body) => {
        this.status.transport.mode = body.mode;
        return this.status.transport;
      }),
      this.handle<TransportKeyRequest, { keyId: string }>(
        'put',
        '/api/transport/keys/:keyId',
        (body, params) => this.enrollKey(params.keyId, body.psk),
      ),
      this.handle<never, { keyId: string }>(
        'delete',
        '/api/transport/keys/:keyId',
        (_body, params) => {
          const keys = this.status.transport.key_ids;
          if (!keys.includes(params.keyId)) return reject(404, 'unknown credential');
          this.status.transport.key_ids = keys.filter((id) => id !== params.keyId);
          return { deleted: params.keyId };
        },
      ),
      this.handle('post', '/api/unlock', () => ({ ok: true })),
      this.handle('get', '/api/recordings/capabilities', () => this.capabilities),
      this.handle('get', '/api/recordings', () => this.recordings()),
      this.handle<StartRecordingRequest>('post', '/api/recordings', (body) =>
        this.startRecording(body),
      ),
      this.handle<never, { recordingId: string }>(
        'post',
        '/api/recordings/:recordingId/stop',
        (_body, params) => this.stopRecording(params.recordingId),
      ),
      this.handle<never, { recordingId: string }>(
        'delete',
        '/api/recordings/:recordingId',
        (_body, params) => {
          const saved = this.saved.find((item) => item.id === params.recordingId);
          if (!saved) return reject(404, 'unknown recording');
          this.saved = this.saved.filter((item) => item.id !== params.recordingId);
          return { deleted: params.recordingId };
        },
      ),
      this.handle<never, { recordingId: string }>(
        'post',
        '/api/recordings/:recordingId/download-ticket',
        (_body, params) => {
          if (!this.saved.some((item) => item.id === params.recordingId)) {
            return reject(404, 'unknown recording');
          }
          return {
            url: `/api/recordings/${params.recordingId}/file?ticket=mock`,
            expires_in_seconds: 60,
          };
        },
      ),
      this.handle<never, { recordingId: string }>('get', '/api/recordings/:recordingId/file', () =>
        silentWav(),
      ),
    ];
  }

  /**
   * One route: operations the contract secures check the bearer token before
   * the body runs. The result may be an error `HttpResponse`.
   */
  private handle<Body = never, Params extends Record<string, string> = Record<string, never>>(
    method: 'get' | 'post' | 'put' | 'delete',
    path: string,
    apply: (body: Body, params: Params) => JsonBodyType | Response,
  ): HttpHandler {
    return http[method](path, async ({ request, params }) => {
      const requestPath = new URL(request.url).pathname;
      if (
        operationSecured(method, requestPath) &&
        request.headers.get('authorization') !== `Bearer ${MOCK_BRIDGE_TOKEN}`
      ) {
        return reject(401, 'invalid API token');
      }
      const body = (await request.json().catch(() => ({}))) as Body;
      const result = apply(body, params as Params);
      return result instanceof Response ? result : HttpResponse.json(result);
    });
  }

  /** The one live source streams only in cleartext mode without credentials. */
  private statusResponse(): BridgeStatus {
    const transport = this.status.transport;
    const cleartextOpen = transport.mode === 'cleartext';
    const source = this.status.sources['192.0.2.10'];
    if (source) {
      source.lifecycle.state = cleartextOpen ? 'connected' : 'disconnected';
      if (cleartextOpen) {
        source.packets += 100;
        source.bytes += 176400;
        source.uptime_seconds += 1;
      }
    }
    return this.status;
  }

  private enrollKey(keyId: string, psk: string): JsonBodyType | Response {
    if (!KEY_ID_PATTERN.test(keyId)) return reject(422, 'credential ID must be eli1-<32 hex>');
    if (!PSK_PATTERN.test(psk)) return reject(422, 'PSK must be 64 hex characters');
    const keys = this.status.transport.key_ids;
    if (!keys.includes(keyId)) keys.push(keyId);
    return { key_id: keyId };
  }

  private recordings(): RecordingList {
    return { active: this.active, saved: this.saved, storage: { free_bytes: 32 * 1024 ** 3 } };
  }

  private startRecording(body: StartRecordingRequest): JsonBodyType | Response {
    if (!body.source || !(body.source in this.status.sources)) {
      return reject(422, 'unknown source');
    }
    this.recordingSerial += 1;
    const recording: RecordingSnapshot = {
      id: `rec-${this.recordingSerial}`,
      title: body.title,
      source: body.source,
      state: 'waiting-for-audio',
      created_at: '2026-01-01T00:00:00Z',
      audio_started_at: null,
      finished_at: null,
      duration_seconds: 0,
      bytes: 0,
      frames: 0,
      gap_packets: 0,
      duplicate_packets: 0,
      file_name: null,
      error: null,
    };
    this.active = [...this.active, recording];
    return { recording };
  }

  private stopRecording(recordingId: string): JsonBodyType | Response {
    const recording = this.active.find((item) => item.id === recordingId);
    if (!recording) return reject(404, 'unknown recording');
    this.active = this.active.filter((item) => item.id !== recordingId);
    const stopped: RecordingSnapshot = {
      ...recording,
      state: 'complete',
      finished_at: '2026-01-01T00:03:00Z',
      duration_seconds: 180,
      bytes: 180 * this.capabilities.format.bytes_per_second,
      file_name: `${recording.id}.wav`,
    };
    this.saved = [stopped, ...this.saved];
    return { recording: stopped };
  }
}

function reject(status: number, message: string): Response {
  return HttpResponse.json({ error: { code: 'error', message } }, { status });
}

/** A valid, silent one-frame WAV so stream and file endpoints serve real audio. */
function silentWav(): Response {
  const header = new Uint8Array(48);
  const view = new DataView(header.buffer);
  const tag = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) header[offset + i] = text.charCodeAt(i);
  };
  tag(0, 'RIFF');
  view.setUint32(4, 40, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 44100, true);
  view.setUint32(28, 176400, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, 4, true);
  return new HttpResponse(header, { headers: { 'Content-Type': 'audio/wav' } });
}
