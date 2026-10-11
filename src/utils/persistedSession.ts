import type { EditorPage, PageSize, PrintOverlayOptions } from '../hooks/usePdfEditor';
import { openDatabase, type KeyValueStoreConfig } from './indexedDbStore';

export interface PersistedFileRecord {
    id: string;
    name: string;
    type: string;
    lastModified: number;
    pageCount: number;
    buffer: ArrayBuffer;
}

export interface PersistedEditorSession {
    files: PersistedFileRecord[];
    pages: EditorPage[];
    pageSize: PageSize;
    savedAt: number;
    printOverlayOptions?: PrintOverlayOptions;
}

const SESSION_STORE: KeyValueStoreConfig = {
    databaseName: 'pageforge-session-db',
    version: 1,
    storeName: 'sessions',
    label: 'session',
};
const SESSION_KEY = 'current';

const REVISION_KEY = 'revision';

export class SessionConflictError extends Error {
    constructor() {
        super('Another tab changed the saved session. Export your work before reloading.');
        this.name = 'SessionConflictError';
    }
}

export interface SessionSnapshot {
    session: PersistedEditorSession | null;
    revision: number;
}

// Compare and write in ONE IndexedDB transaction. A JS queue alone cannot
// serialize writers running in different tabs (or different module instances).
const transact = async (mode: IDBTransactionMode, session?: PersistedEditorSession | null, expectedRevision?: number): Promise<SessionSnapshot> => {
    const database = await openDatabase(SESSION_STORE);
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(SESSION_STORE.storeName, mode);
        const store = transaction.objectStore(SESSION_STORE.storeName);
        let result: SessionSnapshot = { session: null, revision: 0 };
        let conflict = false;
        let failure: unknown;
        transaction.oncomplete = () => { database.close(); resolve(result); };
        transaction.onabort = () => {
            database.close();
            reject(conflict ? new SessionConflictError() : failure ?? transaction.error ?? new Error('Session transaction aborted.'));
        };
        const revisionRequest = store.get(REVISION_KEY);
        revisionRequest.onsuccess = () => {
            try {
            const revision = typeof revisionRequest.result === 'number' ? revisionRequest.result : 0;
            if (mode === 'readwrite') {
                if (expectedRevision !== undefined && expectedRevision !== revision) {
                    conflict = true;
                    transaction.abort();
                    return;
                }
                result = { session: session ?? null, revision: revision + 1 };
                store.put(result.revision, REVISION_KEY);
                if (session) store.put(session, SESSION_KEY);
                else store.delete(SESSION_KEY);
            } else {
                const request = store.get(SESSION_KEY);
                request.onsuccess = () => { result = { revision, session: request.result ?? null }; };
            }
            } catch (error) {
                failure = error;
                transaction.abort();
            }
        };
    });
};

let pendingOperation: Promise<void> = Promise.resolve();

// Saves, clears and loads run strictly in call order, so a load never reads a
// session that an earlier clear is about to delete.
const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const current = pendingOperation.then(operation);
    pendingOperation = current.then(() => undefined, () => undefined);
    return current;
};

export const savePersistedSession = (session: PersistedEditorSession, expectedRevision?: number) =>
    enqueue(() => transact('readwrite', session, expectedRevision));

export const loadSessionSnapshot = () => enqueue(() => transact('readonly'));

export const loadPersistedSession = async () =>
    (await loadSessionSnapshot()).session;

export const clearPersistedSession = (expectedRevision?: number) =>
    enqueue(() => transact('readwrite', null, expectedRevision));
