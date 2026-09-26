import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSessionPersistencePreference, setSessionPersistencePreference } from './sessionPreference';

afterEach(() => vi.unstubAllGlobals());

describe('session persistence preference', () => {
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
