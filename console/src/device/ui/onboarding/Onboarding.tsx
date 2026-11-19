import { useMutation } from '@tanstack/preact-query';
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
import { fieldErrors } from '../../../shared/http';
import { queryClient } from '../../../shared/queries';
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
  const [errors, setErrors] = useState<Record<string, string>>({});
  const join = useMutation(
    {
      mutationFn: () => joinNetwork(entry),
      onSuccess: () => setErrors({}),
      onError: (error) => setErrors(fieldErrors(error, WIFI_FIELDS)),
    },
    queryClient,
  );

  const submit = async () => {
    setKeyAsked(true);
    if (keyUnconfirmed(keySaved)) return;
    await join.mutateAsync().catch(() => undefined);
  };

  return (
    <>
      <Conditions conditions={deviceConditions()} />
      <TopBar title="Set up StreamLine" />
      <Content>
        <Form className="flex flex-col gap-4" errors={errors} onSubmit={submit}>
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
                disabled={join.isPending}
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
                  title="Generated key"
                  description="Keep it in a password manager before the device joins your Wi-Fi."
                  label="Admin key"
                  secret={setupKey.value}
                  copyLabel="Copy key"
                  lost="A lost key needs a reflash: no screen shows it again."
                />
              )}
              <Checkbox checked={keySaved} onCheckedChange={setKeySaved}>
                I saved the key outside this console
              </Checkbox>
              {keyAsked && keyUnconfirmed(keySaved) && (
                <Notice
                  tone="danger"
                  title="Confirm the admin key is saved outside this console."
                />
              )}
            </CardBody>
          </Card>
          {join.error && Object.keys(errors).length === 0 && (
            <Notice
              tone="danger"
              title="The device did not save the network."
              description={errorMessage(join.error)}
            />
          )}
          <div className="flex justify-end">
            <Button type="submit" variant="primary" busy={join.isPending}>
              Join network
            </Button>
          </div>
        </Form>
      </Content>
    </>
  );
}
