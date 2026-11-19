import { useQuery } from '@tanstack/preact-query';
import {
  Actions,
  Button,
  Card,
  CardBody,
  CardHead,
  Fact,
  Facts,
  Form,
  useUnsavedChanges,
} from 'linen';
import { useRef, useState } from 'react';
import { getSetWifiUrl, type SettingsResponse } from '../../../generated/api';
import { fieldErrors } from '../../../shared/http';
import { queryClient } from '../../../shared/queries';
import { ReadNotice } from '../../../shared/ReadNotice';
import { WriteConfirm } from '../../../shared/WriteConfirm';
import { storesWifiPassword, WIFI_FIELDS, type WifiEntry } from '../../lib/wifi';
import { withAccess } from '../../state/access';
import { status } from '../../state/device';
import { homeAddress } from '../../state/handoff';
import { joinNetwork } from '../../state/join';
import { updateLock } from '../../state/ota';
import { settingsQuery } from '../../state/queries';
import { WifiFields } from '../wifi/WifiFields';

/** The network the device joins, and a change of it, which ends in a handoff like first contact. */
export function WifiSection() {
  const wifi = status.value?.wifi;
  const settings = useQuery(settingsQuery, queryClient);
  if (!wifi) return null;
  return (
    <>
      <Card>
        <CardHead title="Connection" description="The network the device joins at every start." />
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
      {settings.data ? (
        <ChangeWifi saved={settings.data} />
      ) : (
        <ReadNotice read={settings} name="device settings" />
      )}
    </>
  );
}

function ChangeWifi({ saved }: { saved: SettingsResponse }) {
  const known = status.value;
  const storedPassword = storesWifiPassword(saved);
  const [entry, setEntry] = useState<WifiEntry>({
    ssid: saved.ssid,
    password: '',
    open: saved.open_network,
  });
  const [asking, setAsking] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // The submit is answered when the confirmation closes, so a refused field takes the focus.
  const answered = useRef<() => void>(() => {});
  const unsaved =
    entry.ssid.trim() !== saved.ssid || entry.password !== '' || entry.open !== saved.open_network;
  // The confirmation holds the page while the join is written, then the handoff takes it.
  useUnsavedChanges(unsaved, { name: 'the Wi-Fi settings', pending: asking });
  // Joining restarts the device, which waits while an update runs.
  const held = updateLock(getSetWifiUrl());

  const join = async () => {
    try {
      await withAccess(() => joinNetwork(entry));
      setErrors({});
    } catch (error) {
      const refused = fieldErrors(error, WIFI_FIELDS);
      setErrors(refused);
      // A refused field shows on the field, and the confirmation closes.
      if (Object.keys(refused).length === 0) throw error;
    }
  };

  return (
    <Card>
      <CardHead
        title="Change Wi-Fi"
        description="For a new password or another network. Audio, the bridge, profiles and the admin key stay as they are."
      />
      <Form
        errors={errors}
        onSubmit={() =>
          new Promise<void>((done) => {
            answered.current = done;
            setAsking(true);
          })
        }
      >
        <CardBody>
          <WifiFields entry={entry} onChange={setEntry} storedPassword={storedPassword} />
          <Actions className="justify-end">
            {held && <p className="mr-auto text-sm text-text-secondary">{held}</p>}
            <Button type="submit" variant="primary" disabled={!unsaved || held !== null}>
              Join network
            </Button>
          </Actions>
        </CardBody>
      </Form>
      <WriteConfirm
        open={asking}
        onOpenChange={(open) => {
          setAsking(open);
          if (!open) answered.current();
        }}
        title={`Join ${entry.ssid.trim()}?`}
        description={`The device restarts to join it, and this page loses contact. Then connect to ${entry.ssid.trim()} and open ${homeAddress(known)}.`}
        confirmLabel="Join network"
        failed="The device did not save the network."
        write={join}
      />
    </Card>
  );
}
