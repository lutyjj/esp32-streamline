import type { HTMLAttributes } from 'preact';

declare module 'preact' {
  namespace JSX {
    interface IntrinsicElements {
      'esp-web-install-button': HTMLAttributes<HTMLElement> & {
        manifest: string;
      };
    }
  }
}
