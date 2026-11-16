import { Button, Card, CardHead, SettingRow } from 'linen';
import { ThemeSetting } from '../../../shared/ThemeChoice';
import { forgetAdminKey, keyRemembered, storedAdminKey, useAuthEpoch } from '../../lib/adminKey';

/** What this browser keeps for the device: the admin key, if any, and the theme. */
export function BrowserSection() {
  useAuthEpoch();
  const stored = storedAdminKey() !== '';
  return (
    <Card>
      <CardHead title="This browser" description="What this browser keeps for this device." />
      <SettingRow
        title="Admin key"
        description={
          keyRemembered()
            ? 'Remembered on this browser until it forgets it.'
            : stored
              ? 'Kept until this tab closes.'
              : 'Not kept. A change asks for it.'
        }
      >
        {stored && <Button onClick={forgetAdminKey}>Forget the key</Button>}
      </SettingRow>
      <ThemeSetting />
    </Card>
  );
}
