import {
  Button,
  Card,
  CardBody,
  CardHead,
  Checkbox,
  Conditions,
  Content,
  Form,
  Notice,
  ShownOnce,
  TopBar,
} from 'linen';
import { useMemo, useState } from 'react';
import { errorMessage } from '../../../shared/errors';
import { fieldErrors } from '../../../shared/http';
import { WIFI_FIELDS, type WifiEntry } from '../../lib/wifi';
import { joinNetwork, keyUnconfirmed } from '../../state/join';
import { setupKey } from '../../state/setupKey';
import { deviceConditions } from '../DeviceConditions';
import { WifiFields } from '../wifi/WifiFields';

/**
 * First contact on the setup network: the Wi-Fi the device joins and the
 * admin key it adopts, kept by the owner before the device leaves.
 */
export function Onboarding() {
  const [entry, setEntry] = useState<WifiEntry>({ ssid: '', password: '', open: false });
  const [keySaved, setKeySaved] = useState(false);
  const [keyAsked, setKeyAsked] = useState(false);
  const [joining, setJoining] = useState(false);
  const [refusal, setRefusal] = useState<{ error: unknown } | null>(null);
  // Held between renders: Base UI hands a field's error back whenever this changes.
  const errors = useMemo(() => fieldErrors(refusal?.error, WIFI_FIELDS), [refusal]);

  const join = async () => {
    setKeyAsked(true);
    if (keyUnconfirmed(keySaved)) return;
    setJoining(true);
    try {
      await joinNetwork(entry);
      setRefusal(null);
    } catch (error) {
      setRefusal({ error });
    } finally {
      setJoining(false);
    }
  };

  return (
    <>
      <Conditions conditions={deviceConditions()} />
      <TopBar title="Set up StreamLine" />
      <Content>
        <Form className="grid gap-4" errors={errors} onSubmit={join}>
          <Card>
            <CardHead
              title="Your Wi-Fi"
              description="The network the device joins at every start."
            />
            <CardBody>
              <WifiFields
                entry={entry}
                onChange={setEntry}
                storedPassword={false}
                disabled={joining}
              />
            </CardBody>
          </Card>
          <Card>
            <CardHead
              title="Admin key"
              description="Settings change only with this key. This setup address and the device's address on your Wi-Fi are different sites, so this browser cannot carry it there."
            />
            <CardBody>
              {setupKey.value && (
                <ShownOnce
                  what="Admin key"
                  label="Admin key"
                  secret={setupKey.value}
                  copyLabel="Copy key"
                  lost="A lost key needs a reflash: no screen shows it again."
                >
                  Keep it in a password manager before the device joins your Wi-Fi.
                </ShownOnce>
              )}
              <Checkbox className="mt-4" checked={keySaved} onCheckedChange={setKeySaved}>
                I saved the key outside this console
              </Checkbox>
              {keyAsked && keyUnconfirmed(keySaved) && (
                <Notice
                  className="mt-3"
                  tone="danger"
                  title="Confirm the admin key is saved outside this console."
                />
              )}
            </CardBody>
          </Card>
          {refusal && Object.keys(errors).length === 0 && (
            <Notice
              tone="danger"
              title="The device did not save the network."
              description={errorMessage(refusal.error)}
            />
          )}
          <div className="flex justify-end">
            <Button type="submit" variant="primary" busy={joining}>
              Join network
            </Button>
          </div>
        </Form>
      </Content>
    </>
  );
}
