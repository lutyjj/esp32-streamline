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
import { useState } from 'react';
import { errorMessage } from '../../../shared/errors';
import { fieldRefusal } from '../../../shared/http';
import { WIFI_FIELDS, type WifiEntry } from '../../lib/wifi';
import { joinBlocks, joinNetwork } from '../../state/join';
import { setupKey } from '../../state/setupKey';
import { DeviceConditions } from '../DeviceConditions';
import { WifiFields } from '../wifi/WifiFields';

/**
 * First contact on the setup network: the Wi-Fi the device joins and the
 * admin key it adopts, kept by the owner before the device leaves.
 */
export function Onboarding() {
  const [entry, setEntry] = useState<WifiEntry>({ ssid: '', password: '', open: false });
  const [keySaved, setKeySaved] = useState(false);
  const [tried, setTried] = useState(false);
  const [joining, setJoining] = useState(false);
  const [refusal, setRefusal] = useState<{ error: unknown } | null>(null);
  const blocks = joinBlocks(entry, keySaved);
  const shown = tried ? blocks : [];
  const refused = fieldRefusal(refusal?.error, WIFI_FIELDS);

  const join = async () => {
    setTried(true);
    setRefusal(null);
    if (blocks.length > 0) return;
    setJoining(true);
    try {
      await joinNetwork(entry);
    } catch (error) {
      setRefusal({ error });
    } finally {
      setJoining(false);
    }
  };

  return (
    <>
      <Conditions>
        <DeviceConditions />
      </Conditions>
      <TopBar title="Set up StreamLine" />
      <Content>
        <Form className="grid gap-4" onSubmit={join}>
          <Card>
            <CardHead
              title="Your Wi-Fi"
              description="The network the device joins at every start."
            />
            <CardBody>
              <WifiFields
                entry={entry}
                onChange={(next) => {
                  setRefusal(null);
                  setEntry(next);
                }}
                problems={[
                  ...(refused ? [refused] : []),
                  ...shown.flatMap((block) => (block.field === 'key' ? [] : [block])),
                ]}
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
              {shown.some((block) => block.field === 'key') && (
                <Notice
                  className="mt-3"
                  tone="danger"
                  title={shown.find((block) => block.field === 'key')?.text ?? ''}
                />
              )}
            </CardBody>
          </Card>
          {refusal && !refused && (
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
