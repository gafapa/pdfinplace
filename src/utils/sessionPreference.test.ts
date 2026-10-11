import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSessionPersistencePreference, setSessionPersistencePreference, subscribeToSessionPreference } from './sessionPreference';

afterEach(() => vi.unstubAllGlobals());

describe('session persistence preference', () => {
    it('propagates a preference changed by another tab and removes its listener', () => {
        const browserWindow = new EventTarget();
        let enabled = true;
        vi.stubGlobal('window', browserWindow);
        vi.stubGlobal('localStorage', { getItem: () => String(enabled) });
        const listener = vi.fn();
        const unsubscribe = subscribeToSessionPreference(listener);
        enabled = false;
        browserWindow.dispatchEvent(Object.assign(new Event('storage'), { key: 'pageforge.local-persistence-enabled' }));
        expect(listener).toHaveBeenCalledExactlyOnceWith(false);
        unsubscribe();
        enabled = true;
        browserWindow.dispatchEvent(Object.assign(new Event('storage'), { key: 'pageforge.local-persistence-enabled' }));
        expect(listener).toHaveBeenCalledTimes(1);
    });
    it('defaults to disabled when browser storage has no explicit choice', () => {
        const values = new Map<string, string>();
        vi.stubGlobal('window', { dispatchEvent: vi.fn() });
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
        });

        expect(getSessionPersistencePreference()).toBe(false);
        setSessionPersistencePreference(true);
        expect(getSessionPersistencePreference()).toBe(true);
        setSessionPersistencePreference(false);
        expect(getSessionPersistencePreference()).toBe(false);
    });

    it('stays disabled when storage is unavailable', () => {
        vi.stubGlobal('window', {});
        vi.stubGlobal('localStorage', { getItem: () => { throw new Error('Unavailable'); } });
        expect(getSessionPersistencePreference()).toBe(false);
    });
});
