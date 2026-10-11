import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBrowserPreference, removeBrowserPreference, writeBrowserPreference } from './browserPreferences';

afterEach(() => vi.unstubAllGlobals());

describe('optional browser preferences', () => {
    it('keeps preference operations usable when storage is denied or full', () => {
        vi.stubGlobal('localStorage', {
            getItem: () => { throw new DOMException('Denied', 'SecurityError'); },
            setItem: () => { throw new DOMException('Full', 'QuotaExceededError'); },
            removeItem: () => { throw new DOMException('Denied', 'SecurityError'); },
        });
        expect(readBrowserPreference('pageforge.locale')).toBeNull();
        expect(writeBrowserPreference('pageforge.locale', 'en')).toBe(false);
        expect(removeBrowserPreference('pageforge.locale')).toBe(false);
    });
});
