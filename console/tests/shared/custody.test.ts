import { afterEach, describe, expect, it } from 'vitest';
import { custodyDegraded, custodyStore } from '../../src/shared/custody';

function blockedStorage(): Storage {
  const deny = () => {
    throw new DOMException('denied', 'SecurityError');
  };
  return {
    getItem: deny,
    setItem: deny,
    removeItem: deny,
  } as unknown as Storage;
}

describe('custody store', () => {
  afterEach(() => {
    custodyDegraded.value = false;
  });

  it('keeps values usable for the tab when the backing store throws', () => {
    const store = custodyStore(blockedStorage);

    expect(store.set('k', 'v')).toBe(false);
    expect(store.get('k')).toBe('v');
    expect(() => store.remove('k')).not.toThrow();
    expect(store.get('k')).toBeNull();
  });

  it('reports degraded custody once a durable write fails', () => {
    const store = custodyStore(blockedStorage);
    expect(custodyDegraded.value).toBe(false);

    store.set('k', 'v');
    expect(custodyDegraded.value).toBe(true);
  });

  it('reads through to a working backing store and reports persistence', () => {
    const backing = new Map<string, string>();
    const store = custodyStore(
      () =>
        ({
          getItem: (k: string) => backing.get(k) ?? null,
          setItem: (k: string, v: string) => void backing.set(k, v),
          removeItem: (k: string) => void backing.delete(k),
        }) as unknown as Storage,
    );

    expect(store.set('k', 'v')).toBe(true);
    expect(backing.get('k')).toBe('v');
    expect(custodyDegraded.value).toBe(false);

    store.remove('k');
    expect(backing.has('k')).toBe(false);
    expect(store.get('k')).toBeNull();
  });

  it('survives a backing store whose access itself throws', () => {
    const store = custodyStore(() => {
      throw new DOMException('denied', 'SecurityError');
    });

    expect(store.set('k', 'v')).toBe(false);
    expect(store.get('k')).toBe('v');
  });
});
