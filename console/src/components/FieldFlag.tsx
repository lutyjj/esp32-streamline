import type { DeviceField } from '../lib/hooks';

/**
 * The status of a control bound to a live device value (see `useDeviceField`):
 * a warn-toned "Unsaved" while the user holds an edit, or a brief "Updated"
 * that fades after the device moved the value under them. Nothing when the
 * field simply mirrors the device. Sits inline in the control's label.
 */
export function FieldFlag({ field }: { field: DeviceField }) {
  if (field.dirty) return <span class="fieldflag warn">Unsaved</span>;
  if (field.revision > 0) {
    // Re-key on each device move so the fade animation replays.
    return (
      <span key={field.revision} class="fieldflag live">
        Updated
      </span>
    );
  }
  return null;
}
