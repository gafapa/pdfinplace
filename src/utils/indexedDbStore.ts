export interface KeyValueStoreConfig {
    databaseName: string;
    version: number;
    storeName: string;
    label: string;
}

const openDatabase = ({ databaseName, version, storeName, label }: KeyValueStoreConfig): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName, version);
        let rejected = false;

        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(storeName)) {
                request.result.createObjectStore(storeName);
            }
        };
        request.onsuccess = () => {
            const database = request.result;
            // A blocked open still succeeds once the other tab lets go; the caller
            // has already been told it failed, so release that late connection.
            if (rejected) {
                database.close();
                return;
            }
            // Never hold an upgrade or deletion from another tab hostage.
            database.onversionchange = () => database.close();
            resolve(database);
        };
        request.onerror = () => reject(request.error ?? new Error(`Failed to open the ${label} database.`));
        request.onblocked = () => {
            rejected = true;
            reject(new Error(`The ${label} database is blocked by another tab.`));
        };
    });

/** Runs one request in its own transaction and always closes the connection. */
export const runStoreRequest = async <T>(
    config: KeyValueStoreConfig,
    mode: IDBTransactionMode,
    createRequest: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => {
    const database = await openDatabase(config);

    return new Promise<T>((resolve, reject) => {
        let request: IDBRequest<T> | undefined;
        try {
            const transaction = database.transaction(config.storeName, mode);
            transaction.oncomplete = () => {
                database.close();
                if (request) resolve(request.result);
            };
            transaction.onabort = () => {
                database.close();
                reject(transaction.error ?? new Error(`The ${config.label} transaction was aborted.`));
            };
            transaction.onerror = () => {
                database.close();
                reject(transaction.error ?? new Error(`The ${config.label} transaction failed.`));
            };
            // put/get/delete throw synchronously for e.g. a non-cloneable value.
            request = createRequest(transaction.objectStore(config.storeName));
        } catch (error) {
            database.close();
            reject(error);
        }
    });
};
