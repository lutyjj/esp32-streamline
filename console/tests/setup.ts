// Node's experimental localStorage/sessionStorage globals shadow the DOM
// environment's storages (localStorage is inert without --localstorage-file),
// and the test environment does not override existing globals. Bind real
// Storage implementations from a dedicated happy-dom window instead; setup
// runs per test file, so each file gets clean storage.
import { Window } from 'happy-dom';

const storageWindow = new Window();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  get: () => storageWindow.localStorage,
});
Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  get: () => storageWindow.sessionStorage,
});
