import { describe, expect, it, vi } from 'vitest';

const tracking = vi.hoisted(() => ({ workerCount: 0, options: [] as Record<string, unknown>[] }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?worker', () => ({ default: class WorkerPort {} }));
vi.mock('pdfjs-dist/build/pdf.min.mjs', () => ({
    GlobalWorkerOptions: { workerPort: null },
    PDFWorker: class {
        static create() { return new this(); }
        destroyed = false;
        constructor() { tracking.workerCount++; }
        destroy() { this.destroyed = true; }
    },
    getDocument: (options: Record<string, unknown>) => {
        tracking.options.push(options);
        return { destroy: async () => {}, promise: Promise.resolve({}) };
    },
}));

describe('PDF.js shared worker ownership', () => {
    it('passes the same explicitly owned worker to concurrent and later loads', async () => {
        const { getPdfDocument } = await import('./pdfjs');
        const [first, second] = await Promise.all([
            getPdfDocument({ data: new Uint8Array([1]) }),
            getPdfDocument({ data: new Uint8Array([2]) }),
        ]);
        await first.destroy();
        await getPdfDocument({ data: new Uint8Array([3]) });
        const worker = tracking.options[0].worker;
        expect(worker).toBeDefined();
        expect(tracking.workerCount).toBe(1);
        expect(tracking.options.every(options => options.worker === worker)).toBe(true);
        expect(worker).toMatchObject({ destroyed: false });
        await second.destroy();
    });
});
