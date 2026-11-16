import { Checkbox, FormDialog, TextField } from 'linen';
import { type ReactNode, useState } from 'react';
import { answerCredential, credentialAsked, credentialAsks } from './credentialGate';
import { errorMessage } from './errors';

type Verdict = 'accepted' | 'rejected';

interface CredentialProps {
  title: string;
  /** Where the credential comes from, and what to do without it. */
  description: ReactNode;
  label: string;
  /** The account a password manager files the credential under. */
  username?: string;
  /** Offers to keep the credential in this browser beyond the tab. */
  remember?: string;
  /** What a refused credential means. */
  rejected: string;
  verify: (secret: string, remember: boolean) => Promise<Verdict>;
}

/**
 * The one credential dialog both consoles use. It opens whenever a write
 * finds the console locked, checks the credential before it closes, keeps a
 * rejection beside the field for another try, then lets the write go on.
 */
export function CredentialDialog(props: CredentialProps) {
  // Each question starts with empty fields; the last one keeps its words while it leaves.
  return <CredentialQuestion key={credentialAsks.value} {...props} />;
}

function CredentialQuestion({
  title,
  description,
  label,
  username,
  remember,
  rejected,
  verify,
}: CredentialProps) {
  const [secret, setSecret] = useState('');
  const [keep, setKeep] = useState(false);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState('');

  const submit = async () => {
    setChecking(true);
    setProblem('');
    try {
      const verdict = await verify(secret.trim(), keep);
      if (!credentialAsked.value) return;
      if (verdict === 'accepted') answerCredential(true);
      else setProblem(rejected);
    } catch (error) {
      setProblem(`The check did not complete: ${errorMessage(error)}. Try again.`);
    } finally {
      setChecking(false);
    }
  };

  return (
    <FormDialog
      open={credentialAsked.value}
      onOpenChange={(open) => {
        if (!open) answerCredential(false);
      }}
      title={title}
      description={description}
      confirmLabel="Unlock"
      // Stand-in for busy on a dialog's confirm, which linen does not offer yet.
      disabled={checking || secret.trim() === ''}
      onConfirm={() => void submit()}
    >
      {username !== undefined && (
        <input type="text" autoComplete="username" value={username} readOnly hidden />
      )}
      <TextField
        label={label}
        type="password"
        autoComplete="current-password"
        autoFocus
        value={secret}
        readOnly={checking}
        error={problem === '' ? undefined : problem}
        onChange={(event) => setSecret(event.currentTarget.value)}
      />
      {remember !== undefined && (
        <Checkbox checked={keep} onCheckedChange={setKeep} secondary>
          {remember}
        </Checkbox>
      )}
    </FormDialog>
  );
}
