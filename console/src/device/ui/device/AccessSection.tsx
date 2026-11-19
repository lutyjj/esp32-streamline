import { useMutation } from '@tanstack/preact-query';
import {
  Actions,
  Button,
  Card,
  CardBody,
  CardHead,
  Checkbox,
  Notice,
  ShownOnce,
  useToast,
  useUnsavedChanges,
} from 'linen';
import { useState } from 'react';
import { queryClient } from '../../../shared/queries';
import { WriteFailure } from '../../../shared/WriteFailure';
import { generateAdminKey } from '../../lib/adminKey';
import { changeAdminKey } from '../../state/access';

/** The device's admin key. */
export function AccessSection() {
  return <AdminKeyCard />;
}

/**
 * A new key is made here and shown once; it replaces the old one only when
 * saved, and only once the owner says it is kept outside this console.
 */
function AdminKeyCard() {
  const toast = useToast();
  const [next, setNext] = useState<string | null>(null);
  const [kept, setKept] = useState(false);
  const [keptAsked, setKeptAsked] = useState(false);
  const change = useMutation(
    {
      mutationFn: (key: string) => changeAdminKey(key),
      onSuccess: (done) => {
        if (!done) return;
        setNext(null);
        toast.show({ text: 'The device takes the new admin key now.' });
      },
    },
    queryClient,
  );
  // An unsaved key may already sit in a password manager in place of the old one.
  useUnsavedChanges(next !== null, { name: 'the new admin key', pending: change.isPending });

  const start = () => {
    setNext(generateAdminKey());
    setKept(false);
    setKeptAsked(false);
    change.reset();
  };
  const save = () => {
    setKeptAsked(true);
    if (next && kept) change.mutate(next);
  };

  return (
    <Card>
      <CardHead
        title="Admin key"
        description="Every change needs it; reading stays open on your network. Replace it when someone else may have it."
      >
        {next === null && <Button onClick={start}>Replace admin key</Button>}
      </CardHead>
      {next !== null && (
        <CardBody>
          <ShownOnce
            title="New admin key"
            description="Keep it in a password manager, then save it here."
            label="New admin key"
            secret={next}
            copyLabel="Copy key"
            lost="Until it is saved the old key stays in use. Once saved, a lost key needs a reflash."
          />
          <Checkbox checked={kept} onCheckedChange={setKept}>
            I saved the new key outside this console
          </Checkbox>
          {keptAsked && !kept && (
            <Notice tone="danger" title="Confirm the new key is saved outside this console." />
          )}
          {change.error && (
            <WriteFailure failed="The device kept its admin key." error={change.error} />
          )}
          <Actions className="justify-end">
            <Button disabled={change.isPending} onClick={() => setNext(null)}>
              Cancel
            </Button>
            <Button variant="primary" busy={change.isPending} onClick={save}>
              Save new key
            </Button>
          </Actions>
        </CardBody>
      )}
    </Card>
  );
}
