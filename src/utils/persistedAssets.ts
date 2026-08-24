export interface PersistedAssetRecord {
    id: string;
    name: string;
    kind: 'signature' | 'stamp';
    dataUrl: string;
    width: number;
    height: number;
}

const DB_NAME = 'pageforge-assets-db';
const DB_VERSION = 1;
const STORE_NAME = 'assets';
const ASSETS_KEY = 'saved';

const openAssetsDatabase = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(STORE_NAME)) {
                request.result.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Failed to open the saved-assets database.'));
        request.onblocked = () => reject(new Error('The saved-assets database is blocked by another tab.'));
    });

const runAssetRequest = async <T>(
    mode: IDBTransactionMode,
    createRequest: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => {
    const database = await openAssetsDatabase();
    return new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const request = createRequest(transaction.objectStore(STORE_NAME));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Saved-assets request failed.'));
        transaction.oncomplete = () => database.close();
        transaction.onabort = () => {
            database.close();
            reject(transaction.error ?? new Error('Saved-assets transaction was aborted.'));
        };
        transaction.onerror = () => {
            database.close();
            reject(transaction.error ?? new Error('Saved-assets transaction failed.'));
        };
    });
};

export const loadPersistedAssets = async (): Promise<PersistedAssetRecord[]> => {
    const result = await runAssetRequest<unknown>('readonly', (store) => store.get(ASSETS_KEY));
    return Array.isArray(result) ? result as PersistedAssetRecord[] : [];
};

export const savePersistedAssets = async (assets: PersistedAssetRecord[]) => {
    await runAssetRequest<IDBValidKey>('readwrite', (store) => store.put(assets, ASSETS_KEY));
};

export const clearPersistedAssets = async () => {
    await runAssetRequest<undefined>('readwrite', (store) => store.delete(ASSETS_KEY));
};
