import type { ComponentChildren } from 'preact';
import { Chip, type Tone } from './Chip';

export function SettingRow({
  title,
  description,
  status,
  tone = 'neutral',
  children,
}: {
  title: string;
  description: ComponentChildren;
  status?: string;
  tone?: Tone;
  children: ComponentChildren;
}) {
  return (
    <div class="setting-row">
      <div class="setting-copy">
        <div class="setting-title">
          <h3>{title}</h3>
          {status && (
            <Chip tone={tone} dot>
              {status}
            </Chip>
          )}
        </div>
        <p>{description}</p>
      </div>
      <div class="setting-action">{children}</div>
    </div>
  );
}
