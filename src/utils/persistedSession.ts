import type { EditorPage, PageSize } from '../hooks/usePdfEditor';

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

const DB_NAME = 'pageforge-session-db';
const DB_VERSION = 1;
const STORE_NAME = 'sessions';
const SESSION_KEY = 'current';

const openSessionDatabase = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                database.createObjectStore(STORE_NAME);
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB.'));
    });

const withStore = async <T>(
    mode: IDBTransactionMode,
    executor: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason?: unknown) => void) => void,
): Promise<T> => {
    const database = await openSessionDatabase();

    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const store = transaction.objectStore(STORE_NAME);

        transaction.oncomplete = () => database.close();
        transaction.onerror = () => {
            database.close();
            reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
        };

        executor(store, resolve, reject);
    });
};

export const savePersistedSession = async (session: PersistedEditorSession) =>
    withStore<void>('readwrite', (store, resolve, reject) => {
        const request = store.put(session, SESSION_KEY);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error('Failed to save session.'));
    });

export const loadPersistedSession = async () =>
    withStore<PersistedEditorSession | null>('readonly', (store, resolve, reject) => {
        const request = store.get(SESSION_KEY);
        request.onsuccess = () => resolve((request.result as PersistedEditorSession | undefined) ?? null);
        request.onerror = () => reject(request.error ?? new Error('Failed to load session.'));
    });

export const clearPersistedSession = async () =>
    withStore<void>('readwrite', (store, resolve, reject) => {
        const request = store.delete(SESSION_KEY);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error('Failed to clear session.'));
    });
