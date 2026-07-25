import {
  getOpenapi,
  setAudioProfiles as replaceAudioProfiles,
  setBoard as selectBoard,
  setAudioProfile,
} from '../generated/api';
import type { ApiDocument } from './contract';

export type {
  Ack,
  AnalogPassthroughCapabilityStatus,
  AnalogPassthroughStatus,
  AudioProfile,
  AudioProfileCatalog,
  AudioSettings as AudioProfileSettings,
  Board as BoardDescriptor,
  BoardCatalogResponse as BoardCatalog,
  BootLog,
  ButtonAction,
  ButtonActionStatus,
  ButtonCapabilityStatus,
  CapabilitiesStatus as BoardCapabilities,
  CheckStatus as HealthCheckStatus,
  ConfigResponse as DeviceConfig,
  HealthCheck,
  HealthReport,
  LedCapabilityStatus,
  LedRole,
  LedRoleStatus,
  LogsResponse,
  OtaStatus as OtaSnapshot,
  Severity as HealthSeverity,
  StatusResponse as DeviceStatus,
  TransportKeyResponse,
  TransportMode,
  TransportSettingsRequest,
  TransportStatus,
} from '../generated/api';
export {
  activateTransportKey,
  discardTransportKey,
  factoryReset,
  getAudioProfiles,
  getBoards,
  getLogs,
  getSettings,
  getStatus,
  otaCheck,
  otaRollback,
  otaUpdate,
  recoverTransport,
  restart,
  retireTransportKey,
  rollbackTransportKey,
  setAdminKey,
  setAnalogPassthrough,
  setAudio,
  setButton,
  setFirmware,
  setLed,
  setName,
  setStream,
  setTarget,
  setTransportMode,
  setWifi,
  stageTransportKey,
  verifyTransportKey,
} from '../generated/api';
export { ApiError, setTransport, verifyAdminKey } from './http';

import type { AudioProfileCatalog, Board } from '../generated/api';

/** The device-served OpenAPI contract; the console renders and validates from it. */
export const getContract = async (): Promise<ApiDocument> => (await getOpenapi()) as ApiDocument;

export const setAudioProfiles = (catalog: AudioProfileCatalog) =>
  replaceAudioProfiles({ catalog: JSON.stringify(catalog) });

export const setActiveAudioProfile = (profileId: string) =>
  setAudioProfile({ profile_id: profileId });

export const setBoard = (boardId: string) => selectBoard({ board_id: boardId });

export const setCustomBoard = (descriptor: Board) =>
  selectBoard({ descriptor: JSON.stringify(descriptor) });
