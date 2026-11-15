import { Card, CardHead, Content, EmptyState, SettingRow } from 'linen';
import { config, status } from '../../state/device';
import { ScreenTop } from '../ScreenTop';

export function BridgeScreen() {
  const target = status.value?.target;
  const transport = config.value?.transport;
  return (
    <>
      <ScreenTop title="Bridge" />
      <Content>
        <Card>
          <CardHead title="Destination" description="Where the device sends its audio." />
          {target?.target_host ? (
            <>
              <SettingRow title="Address">
                <span className="font-mono text-sm">
                  {target.target_host}:{target.target_port}
                </span>
              </SettingRow>
              {transport && (
                <SettingRow title="Encryption">
                  <span className="text-sm">
                    {transport.mode === 'tls-psk'
                      ? 'On'
                      : 'Off: audio crosses the network in the clear'}
                  </span>
                </SettingRow>
              )}
            </>
          ) : (
            <EmptyState
              title="No bridge yet"
              description="Capture and level setting work without one. A bridge turns the input into a stream your players can open."
            />
          )}
        </Card>
      </Content>
    </>
  );
}
