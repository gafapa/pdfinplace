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
        request.onblocked = () => reject(new Error('The session database is blocked by another tab.'));
    });

const withStore = async <T>(
    mode: IDBTransactionMode,
    createRequest: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => {
    const database = await openSessionDatabase();

    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const request = createRequest(transaction.objectStore(STORE_NAME));
        transaction.oncomplete = () => {
            database.close();
            resolve(request.result);
        };
        transaction.onabort = () => {
            database.close();
            reject(transaction.error ?? new Error('IndexedDB transaction was aborted.'));
        };
        transaction.onerror = () => {
            database.close();
            reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
        };
    });
};

let pendingMutation: Promise<void> = Promise.resolve();

const queueMutation = (operation: () => Promise<void>): Promise<void> => {
    const currentMutation = pendingMutation.then(operation);
    pendingMutation = currentMutation.catch(() => undefined);
    return currentMutation;
};

export const savePersistedSession = async (session: PersistedEditorSession) =>
    queueMutation(async () => {
        await withStore<IDBValidKey>('readwrite', (store) => store.put(session, SESSION_KEY));
    });

export const loadPersistedSession = async () => {
    const result = await withStore<PersistedEditorSession | undefined>('readonly', (store) => store.get(SESSION_KEY));
    return result ?? null;
};

export const clearPersistedSession = async () =>
    queueMutation(async () => {
        await withStore<undefined>('readwrite', (store) => store.delete(SESSION_KEY));
    });
