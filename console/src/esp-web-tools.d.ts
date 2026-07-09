export {};

declare module 'preact' {
  namespace JSX {
    interface IntrinsicElements {
      'esp-web-install-button': JSX.HTMLAttributes<HTMLElement> & {
        manifest: string;
      };
    }
  }
}
