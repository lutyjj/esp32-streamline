import { Card, CardHead } from 'linen';
import { ThemeSetting } from '../../../shared/ThemeChoice';

/** How this browser shows the bridge console, which a phone finds here and not at a rail's foot. */
export function BrowserSection() {
  return (
    <Card>
      <CardHead title="This browser" description="How this browser shows the console." />
      <ThemeSetting />
    </Card>
  );
}
