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

    it('does not load a session that an earlier clear is about to delete', async () => {
        const session: PersistedEditorSession = {
            files: [],
            pages: [],
            pageSize: 'Original',
            savedAt: 456,
        };
        await savePersistedSession(session);

        const save = savePersistedSession({ ...session, savedAt: 789 });
        const clear = clearPersistedSession();
        const load = loadPersistedSession();
        await Promise.all([save, clear]);

        expect(await load).toBeNull();
    });
});
