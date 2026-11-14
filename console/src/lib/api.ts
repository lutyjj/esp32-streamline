import {
  getOpenapi,
  setAudioProfiles as replaceAudioProfiles,
  setBoard as selectBoard,
  setAudioProfile,
} from '../generated/api';
import type { ApiDocument } from './contract';

// Types keep their contract names, so one grep finds a field in the firmware
// DTO, the generated client, and every console call site.
export type {
  Ack,
  AnalogPassthroughCapabilityStatus,
  AnalogPassthroughStatus,
  AudioProfile,
  AudioProfileCatalog,
  AudioSettings,
  BoardCatalogResponse,
  BootLog,
  ButtonAction,
  ButtonActionStatus,
  ButtonCapabilityStatus,
  CapabilitiesStatus,
  HealthCheck,
  HealthReport,
  LedCapabilityStatus,
  LedRole,
  LedRoleStatus,
  LogsResponse,
  SettingsResponse,
  SetupNetworkResponse,
  StatusResponse,
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
