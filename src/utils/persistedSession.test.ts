import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { clearPersistedSession, loadPersistedSession, loadSessionSnapshot, savePersistedSession, SessionConflictError, type PersistedEditorSession } from './persistedSession';

beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
});

describe('persisted session mutations', () => {
    const fixture: PersistedEditorSession = { files: [], pages: [], pageSize: 'Original', savedAt: 1 };

    it('atomically rejects a competing writer from a different module instance', async () => {
        // A fresh module has its own queue, just like a second browser tab.
        vi.resetModules();
        const otherTab = await import('./persistedSession');
        const outcomes = await Promise.allSettled([
            savePersistedSession({ ...fixture, savedAt: 11 }, 0),
            otherTab.savePersistedSession({ ...fixture, savedAt: 22 }, 0),
        ]);
        expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
        const result = await loadSessionSnapshot();
        expect(result.revision).toBe(1);
        expect([11, 22]).toContain(result.session?.savedAt);
    });

    it('keeps the winning session when a stale writer tries to save or clear', async () => {
        await savePersistedSession(fixture, 0);
        await expect(savePersistedSession({ ...fixture, savedAt: 2 }, 0)).rejects.toBeInstanceOf(SessionConflictError);
        await expect(clearPersistedSession(0)).rejects.toBeInstanceOf(SessionConflictError);
        expect(await loadSessionSnapshot()).toEqual({ session: fixture, revision: 1 });
    });

    it('keeps a revision after deletion so an old tab cannot resurrect its data', async () => {
        await savePersistedSession(fixture, 0);
        await clearPersistedSession(1);
        expect(await loadSessionSnapshot()).toEqual({ session: null, revision: 2 });
        await expect(savePersistedSession(fixture, 1)).rejects.toBeInstanceOf(SessionConflictError);
        await savePersistedSession(fixture, 2);
        expect((await loadSessionSnapshot()).revision).toBe(3);
    });

    it('recovers its queue after a rejected transaction', async () => {
        await expect(savePersistedSession(fixture, 50)).rejects.toBeInstanceOf(SessionConflictError);
        await savePersistedSession(fixture, 0);
        expect(await loadPersistedSession()).toEqual(fixture);
    });

    it('rolls back the revision when structured cloning fails during a write', async () => {
        const invalid = { ...fixture, savedAt: (() => 1) as unknown as number };
        await expect(savePersistedSession(invalid, 0)).rejects.toMatchObject({ name: 'DataCloneError' });
        expect(await loadSessionSnapshot()).toEqual({ session: null, revision: 0 });
        await savePersistedSession(fixture, 0);
        expect(await loadPersistedSession()).toEqual(fixture);
    });
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
