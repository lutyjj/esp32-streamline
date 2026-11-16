import { useQuery } from '@tanstack/preact-query';
import { Card, CardBody, CardHead, Fact, Facts } from 'linen';
import type { BridgeStatus } from '../../../generated/bridge';
import { queryClient } from '../../../shared/queries';
import { type DeploymentOption, TRANSPORT_STATE_OPTION, whereToSet } from '../../lib/deployment';
import { capabilitiesQuery } from '../../state/queries';

/** A value the deployment leaves unset, and where it is set. */
function Unset({ option, state = 'Not set' }: { option: DeploymentOption; state?: string }) {
  return (
    <>
      {state}
      <span className="block text-sm text-text-secondary">
        Set {whereToSet(option)}, then restart the bridge.
      </span>
    </>
  );
}

/** What the bridge's deployment sets, read here and changed there. */
export function DeploymentSection({ known }: { known: BridgeStatus }) {
  const capabilities = useQuery(capabilitiesQuery, queryClient);
  return (
    <Card>
      <CardHead
        title="Deployment"
        description="The bridge reads these when it starts. Change them in its deployment, then restart it."
      />
      <CardBody>
        <Facts>
          <Fact name="API token">
            {known.api_token_configured ? 'Set' : <Unset option="token" />}
          </Fact>
          <Fact name="Public address" mono={known.public_url !== ''}>
            {known.public_url || <Unset option="publicUrl" />}
          </Fact>
          <Fact name="Music Assistant" mono={known.sendspin.enabled}>
            {known.sendspin.enabled ? (
              known.sendspin.server_url
            ) : (
              <Unset option="sendspin" state="Off" />
            )}
          </Fact>
          {capabilities.data && (
            <Fact name="Recording">
              {capabilities.data.enabled ? 'On' : <Unset option="recordings" state="Off" />}
            </Fact>
          )}
          <Fact name="Audio security">
            {known.transport.configurable ? (
              'Available'
            ) : (
              <>
                Off
                <span className="block text-sm text-text-secondary">
                  Set {TRANSPORT_STATE_OPTION} for a container, then restart the bridge.
                </span>
              </>
            )}
          </Fact>
          <Fact name="Audio port">{known.transport.port}</Fact>
          <Fact name="Version">{known.bridge_version}</Fact>
        </Facts>
      </CardBody>
    </Card>
  );
}
