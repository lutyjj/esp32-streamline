import icon from '../icon.svg?raw';

// The favicon's encoding: Vite would emit the plain import as base64, a second, larger copy.
const src = `data:image/svg+xml,${encodeURIComponent(icon)}`;

export function Wordmark() {
  return (
    <div class="wordmark">
      <img src={src} alt="" width={22} height={22} />
      StreamLine
    </div>
  );
}
