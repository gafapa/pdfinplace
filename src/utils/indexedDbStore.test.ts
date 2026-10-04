import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { runStoreRequest, type KeyValueStoreConfig } from './indexedDbStore';

const config: KeyValueStoreConfig = { databaseName: 'test-db', version: 1, storeName: 'items', label: 'test' };

let factory: IDBFactory;
beforeEach(() => {
    factory = new IDBFactory();
    vi.stubGlobal('indexedDB', factory);
});

const deleteDatabase = () => new Promise<string>((resolve) => {
    const request = factory.deleteDatabase(config.databaseName);
    request.onsuccess = () => resolve('deleted');
    request.onblocked = () => resolve('blocked');
});

describe('runStoreRequest', () => {
    it('closes the connection when the request throws synchronously', async () => {
        await expect(runStoreRequest(config, 'readwrite', (store) => store.put(() => undefined, 'key')))
            .rejects.toThrow();

        // A leaked connection would block the deletion.
        expect(await deleteDatabase()).toBe('deleted');
    });

    it('resolves with the request result after the transaction completes', async () => {
        await runStoreRequest(config, 'readwrite', (store) => store.put('value', 'key'));

        expect(await runStoreRequest(config, 'readonly', (store) => store.get('key'))).toBe('value');
    });

    it('closes a connection that succeeds after its open was reported as blocked', async () => {
        await runStoreRequest(config, 'readwrite', (store) => store.put('value', 'key'));
        const older = await new Promise<IDBDatabase>((resolve) => {
            const request = factory.open(config.databaseName, 1);
            request.onsuccess = () => resolve(request.result);
        });

        const blocked = runStoreRequest({ ...config, version: 2 }, 'readonly', (store) => store.get('key'));
        await expect(blocked).rejects.toThrow('blocked by another tab');
        older.close();
        await new Promise(resolve => setTimeout(resolve, 20));

        // Once the late v2 connection is released, nothing holds the database.
        expect(await deleteDatabase()).toBe('deleted');
    });
});
