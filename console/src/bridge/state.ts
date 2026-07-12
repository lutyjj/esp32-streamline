import { BridgeController } from './controller';

export const bridge = new BridgeController();

export function startBridgePolling(): void {
  bridge.start();
}
