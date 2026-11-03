import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const workerSource = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');

const worker = () => {
    const entries = new Map<string, Response>();
    const listeners = new Map<string, (event: unknown) => void>();
    let writesBeforeFailure = Infinity;
    const cache = {
        keys: async () => [...entries.keys()].map(url => new Request(url)),
        match: async (request: Request) => entries.get(request.url)?.clone(),
        delete: async (request: Request) => entries.delete(request.url),
        put: async (request: Request, response: Response) => {
            if (writesBeforeFailure-- === 0) throw new Error('Synthetic quota failure');
            entries.set(request.url, response.clone());
        },
    };
    runInNewContext(workerSource, {
        self: {
            registration: { scope: 'https://example.test/pdf/' },
            location: { origin: 'https://example.test' },
            addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
        },
        caches: { open: async () => cache, match: async () => undefined },
        fetch: async () => {
            const response = new Response('fresh network content', { headers: { 'content-type': 'text/html' } });
            Object.defineProperty(response, 'type', { value: 'basic' });
            return response;
        },
        crypto: webcrypto, Request, Response, URL, console: { error: vi.fn() },
    });
    const send = (files: Array<Pick<File, 'size'> & Partial<File>>) => {
        let result: Promise<Response> | undefined;
        listeners.get('fetch')!({
            request: { method: 'POST', url: 'https://example.test/pdf/share-target', formData: async () => ({ getAll: () => files }) },
            respondWith: (response: Promise<Response>) => { result = response; },
        });
        return result!;
    };
    const get = (path: string, mode = 'cors') => {
        let result: Promise<Response> | undefined;
        listeners.get('fetch')!({
            request: { method: 'GET', url: `https://example.test${path}`, mode, destination: 'script' },
            respondWith: (response: Promise<Response>) => { result = response; },
        });
        return result!;
    };
    return { entries, send, get, failAfter: (count: number) => { writesBeforeFailure = count; } };
};

describe('service worker share target', () => {
    it('uses an absolute redirect and keeps concurrent deliveries separate', async () => {
        const instance = worker();
        const first = await instance.send([new File(['first'], 'first.pdf', { type: 'application/pdf' })]);
        const second = await instance.send([new File(['second'], 'second.pdf')]);
        expect(first.status).toBe(303);
        const firstUrl = new URL(first.headers.get('location')!);
        const secondUrl = new URL(second.headers.get('location')!);
        expect(firstUrl.pathname).toBe('/pdf/');
        expect(firstUrl.searchParams.get('shared-files')).not.toBe(secondUrl.searchParams.get('shared-files'));
        expect(instance.entries.size).toBe(2);
    });

    it('rejects oversized batches before changing the pending cache', async () => {
        const instance = worker();
        expect((await instance.send([{ size: 76 * 1024 * 1024 }])).status).toBe(413);
        expect((await instance.send(Array.from({ length: 21 }, () => ({ size: 1 })))).status).toBe(413);
        expect((await instance.send(Array.from({ length: 4 }, () => ({ size: 70 * 1024 * 1024 })))).status).toBe(413);
        expect(instance.entries.size).toBe(0);
    });

    it('rolls back only its own partial delivery when storage fails', async () => {
        const instance = worker();
        await instance.send([new File(['keep'], 'previous.pdf')]);
        const previousKeys = [...instance.entries.keys()];
        instance.failAfter(1);
        const response = await instance.send([new File(['one'], 'one.pdf'), new File(['two'], 'two.pdf')]);
        expect(response.status).toBe(503);
        expect([...instance.entries.keys()]).toEqual(previousKeys);
    });

    it('returns successful network responses even when offline-cache writes fail', async () => {
        for (const [path, mode] of [['/pdf/assets/app.js', 'cors'], ['/pdf/pdfjs/current/wasm/qcms_bg.wasm', 'cors'], ['/pdf/', 'navigate']]) {
            const instance = worker();
            instance.failAfter(0);
            expect(await (await instance.get(path, mode)).text()).toBe('fresh network content');
        }
    });
});
