import { createThemeStore } from 'linen';

/**
 * The console's theme in this browser. Each console has its own origin, so
 * each keeps its own choice; `index.html` applies it before the first paint.
 */
export const theme = createThemeStore({ key: 'streamline:theme' });
