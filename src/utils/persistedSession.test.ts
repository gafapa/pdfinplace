import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { clearPersistedSession, loadPersistedSession, savePersistedSession, type PersistedEditorSession } from './persistedSession';

beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
});

describe('persisted session mutations', () => {
    it('clears a save that was still in progress when clearing began', async () => {
        const session: PersistedEditorSession = {
            files: [],
            pages: [],
            pageSize: 'Original',
            savedAt: 123,
        };

        const save = savePersistedSession(session);
        const clear = clearPersistedSession();
        await Promise.all([save, clear]);

        expect(await loadPersistedSession()).toBeNull();
    });
});
