import { runStoreRequest, type KeyValueStoreConfig } from './indexedDbStore';

export interface PersistedAssetRecord {
    id: string;
    name: string;
    dataUrl: string;
    width: number;
    height: number;
}

const ASSETS_STORE: KeyValueStoreConfig = {
    databaseName: 'pageforge-assets-db',
    version: 1,
    storeName: 'assets',
    label: 'saved-assets',
};
const ASSETS_KEY = 'saved';

const runAssetRequest = <T>(mode: IDBTransactionMode, createRequest: (store: IDBObjectStore) => IDBRequest<T>) =>
    runStoreRequest(ASSETS_STORE, mode, createRequest);

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
