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
export const MAX_SAVED_ASSETS = 30;
export const MAX_SAVED_ASSET_BYTES = 25 * 1024 * 1024;

/** Reject damaged libraries as a whole so recovery never silently drops entries. */
export const validatePersistedAssets = (value: unknown): PersistedAssetRecord[] => {
    if (!Array.isArray(value) || value.length > MAX_SAVED_ASSETS) throw new Error('Invalid saved asset library.');
    let bytes = 0;
    const ids = new Set<string>();
    for (const asset of value) {
        if (!asset || typeof asset !== 'object' || typeof asset.id !== 'string' || !asset.id || ids.has(asset.id) ||
            typeof asset.name !== 'string' || typeof asset.dataUrl !== 'string' ||
            !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(asset.dataUrl) ||
            !Number.isFinite(asset.width) || !Number.isFinite(asset.height) || asset.width <= 0 || asset.height <= 0 ||
            asset.width * asset.height > 32_000_000) throw new Error('Invalid saved asset.');
        ids.add(asset.id);
        bytes += Math.ceil(asset.dataUrl.length * 0.75);
        if (bytes > MAX_SAVED_ASSET_BYTES) throw new Error('Saved asset library exceeds the size limit.');
    }
    return value as PersistedAssetRecord[];
};

const runAssetRequest = <T>(mode: IDBTransactionMode, createRequest: (store: IDBObjectStore) => IDBRequest<T>) =>
    runStoreRequest(ASSETS_STORE, mode, createRequest);

export const loadPersistedAssets = async (): Promise<PersistedAssetRecord[]> => {
    const result = await runAssetRequest<unknown>('readonly', (store) => store.get(ASSETS_KEY));
    return result === undefined ? [] : validatePersistedAssets(result);
};

export const savePersistedAssets = async (assets: PersistedAssetRecord[]) => {
    await runAssetRequest<IDBValidKey>('readwrite', (store) => store.put(validatePersistedAssets(assets), ASSETS_KEY));
};

export const clearPersistedAssets = async () => {
    await runAssetRequest<undefined>('readwrite', (store) => store.delete(ASSETS_KEY));
};
