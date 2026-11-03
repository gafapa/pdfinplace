import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { loadPersistedAssets, savePersistedAssets, validatePersistedAssets } from './persistedAssets';

beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()));

describe('saved asset recovery', () => {
    const asset = { id: 'stamp', name: 'Stamp', dataUrl: 'data:image/png;base64,AQID', width: 10, height: 10 };

    it('round trips a library and keeps its committed data after a rejected write', async () => {
        await savePersistedAssets([asset]);
        await expect(savePersistedAssets([{ ...asset, width: Number.NaN }])).rejects.toThrow();
        expect(await loadPersistedAssets()).toEqual([asset]);
    });

    it('rejects malformed libraries without filtering out or silently replacing entries', () => {
        for (const value of [null, {}, [asset, asset], [{ ...asset, dataUrl: 'https://example.com/stamp.png' }], [{ ...asset, width: 1e9 }]]) {
            expect(() => validatePersistedAssets(value)).toThrow();
        }
    });
});
