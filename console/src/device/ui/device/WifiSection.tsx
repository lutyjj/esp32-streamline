import {
  Button,
  Card,
  CardBody,
  CardHead,
  ConfirmDialog,
  Fact,
  Facts,
  Notice,
  useUnsavedChanges,
} from 'linen';
import { useState } from 'react';
import { errorMessage } from '../../../shared/errors';
import { storesWifiPassword, type WifiEntry, wifiProblems } from '../../lib/wifi';
import { withAccess } from '../../state/access';
import { config, configResource, status } from '../../state/device';
import { homeAddress } from '../../state/handoff';
import { joinNetwork } from '../../state/join';
import { ResourceNotice } from '../ResourceNotice';
import { WifiFields } from '../wifi/WifiFields';

/** The network the device joins, and a change of it, which ends in a handoff like first contact. */
export function WifiSection() {
  const wifi = status.value?.wifi;
  if (!wifi) return null;
  return (
    <div className="grid gap-4">
      <Card>
        <CardHead title="Wi-Fi" description="The network the device joins at every start." />
        <CardBody>
          <Facts>
            <Fact name="Network">{wifi.ssid || 'None saved'}</Fact>
            <Fact name="Address" mono>
              {wifi.sta_ip || wifi.ap_ip || 'None'}
            </Fact>
            <Fact
              name="Name on the network"
              mono
              copy={{ value: wifi.hostname, label: 'Name on the network' }}
            >
              {wifi.hostname}
            </Fact>
            {wifi.sta_ip && <Fact name="Signal">{wifi.rssi_dbm} dBm</Fact>}
          </Facts>
        </CardBody>
      </Card>
      {config.value ? <ChangeWifi /> : <ResourceNotice resource={configResource} />}
    </div>
  );
}

function ChangeWifi() {
  const saved = config.value;
  const known = status.value;
  const storedPassword = storesWifiPassword(saved);
  const [entry, setEntry] = useState<WifiEntry>({
    ssid: saved?.ssid ?? '',
    password: '',
    open: saved?.open_network ?? false,
  });
  const [tried, setTried] = useState(false);
  const [asking, setAsking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState('');
  const problems = wifiProblems(entry, storedPassword);
  const unsaved =
    entry.ssid.trim() !== (saved?.ssid ?? '') ||
    entry.password !== '' ||
    entry.open !== (saved?.open_network ?? false);
  useUnsavedChanges(unsaved, { name: 'the Wi-Fi settings', pending: saving });

  const save = async () => {
    setSaving(true);
    setRefusal('');
    try {
      await withAccess(() => joinNetwork(entry, storedPassword));
    } catch (error) {
      setRefusal(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHead
        title="Change Wi-Fi"
        description="For a new password or another network. Audio, the bridge, profiles and the admin key stay as they are."
      />
      <CardBody>
        <WifiFields
          entry={entry}
          onChange={setEntry}
          problems={tried ? problems : []}
          storedPassword={storedPassword}
          disabled={saving}
        />
        {refusal !== '' && (
          <Notice
            className="mt-3"
            tone="danger"
            title="The device did not save the network."
            description={refusal}
          />
        )}
        <div className="mt-4 flex justify-end">
          <Button
            variant="primary"
            busy={saving}
            disabled={!unsaved}
            onClick={() => {
              setTried(true);
              if (problems.length === 0) setAsking(true);
            }}
          >
            Join network
          </Button>
        </div>
      </CardBody>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Join ${entry.ssid.trim()}?`}
        description={`The device restarts to join it, and this page loses contact. Then connect to ${entry.ssid.trim()} and open ${homeAddress(known)}.`}
        confirmLabel="Join network"
        onConfirm={() => void save()}
      />
    </Card>
  );
}
