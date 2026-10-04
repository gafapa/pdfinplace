import type { EditorPage, PageSize } from '../hooks/usePdfEditor';
import { runStoreRequest, type KeyValueStoreConfig } from './indexedDbStore';

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
}

const SESSION_STORE: KeyValueStoreConfig = {
    databaseName: 'pageforge-session-db',
    version: 1,
    storeName: 'sessions',
    label: 'session',
};
const SESSION_KEY = 'current';

const withStore = <T>(mode: IDBTransactionMode, createRequest: (store: IDBObjectStore) => IDBRequest<T>) =>
    runStoreRequest(SESSION_STORE, mode, createRequest);

let pendingOperation: Promise<void> = Promise.resolve();

// Saves, clears and loads run strictly in call order, so a load never reads a
// session that an earlier clear is about to delete.
const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const current = pendingOperation.then(operation);
    pendingOperation = current.then(() => undefined, () => undefined);
    return current;
};

export const savePersistedSession = async (session: PersistedEditorSession) =>
    enqueue(async () => {
        await withStore<IDBValidKey>('readwrite', (store) => store.put(session, SESSION_KEY));
    });

export const loadPersistedSession = async () =>
    enqueue(async () => {
        const result = await withStore<PersistedEditorSession | undefined>('readonly', (store) => store.get(SESSION_KEY));
        return result ?? null;
    });

export const clearPersistedSession = async () =>
    enqueue(async () => {
        await withStore<undefined>('readwrite', (store) => store.delete(SESSION_KEY));
    });
