import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { chromium, firefox, webkit } from 'playwright';
import { startLocalTestServer } from './local-test-server.mjs';

const engines = { chromium, firefox, webkit };
const browserKind = process.env.BROWSER_KIND ?? 'chromium';
assert(browserKind in engines, 'Unsupported browser engine.');
const ownedServer = process.env.WORKBENCH_TEST_URL ? null : await startLocalTestServer('preview');
const baseUrl = process.env.WORKBENCH_TEST_URL ?? ownedServer.url;
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname), 'Use a localhost test server.');
const browser = await engines[browserKind].launch({ headless: true }).catch(async error => {
    await ownedServer?.stop();
    throw error;
});
const makePdf = async count => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (let index = 0; index < count; index++) document.addPage([420, 550]).drawText(`Synthetic page ${index + 1}`, { x: 40, y: 450, font, size: 18 });
    return { name: 'synthetic.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await document.save()) };
};
const smallPdf = await makePdf(1);
const largePdf = await makePdf(100);
const failures = [];
const unexpectedRequests = [];
const createContext = async (persist = true, locale = 'es') => {
    const context = await browser.newContext({ locale: 'es-ES', viewport: { width: 1440, height: 1000 } });
    context.on('page', page => {
        page.on('pageerror', error => failures.push(error.message));
        page.on('dialog', dialog => dialog.accept());
    });
    context.on('request', request => {
        const url = new URL(request.url());
        if (['http:', 'https:'].includes(url.protocol) && (url.origin !== new URL(baseUrl).origin || !['GET', 'HEAD'].includes(request.method()))) unexpectedRequests.push(request.method());
    });
    await context.addInitScript(({ persist, locale }) => {
        if (!['http:', 'https:'].includes(location.protocol)) return;
        // Set preferences once, preserving changes made by later scenarios/reloads.
        if (localStorage.getItem('workbench-test-initialized')) return;
        localStorage.setItem('workbench-test-initialized', 'true');
        localStorage.setItem('pdfinplace.welcome-hidden', 'true');
        localStorage.setItem('pageforge.local-persistence-enabled', String(persist));
        localStorage.setItem('pageforge.locale', locale);
    }, { persist, locale });
    return context;
};
const open = async context => {
    const page = await context.newPage();
    await page.goto(baseUrl);
    await page.locator('[data-session-status]').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-session-status]')?.dataset.sessionStatus !== 'loading');
    return page;
};
const waitStatus = (page, status) => page.locator(`[data-session-status="${status}"]`).waitFor({ timeout: 30000 });
const importFile = async (page, file, count) => {
    await page.locator('input[type=file]').first().setInputFiles(file);
    await page.waitForFunction(count => document.querySelectorAll('.document-card').length === count && !document.querySelector('[data-operation-status]'), count);
};
const snapshot = page => page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('pageforge-session-db', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('sessions', 'readonly');
        const store = tx.objectStore('sessions');
        const session = store.get('current');
        const revision = store.get('revision');
        tx.oncomplete = () => {
            db.close();
            resolve({ revision: revision.result ?? 0, pages: session.result?.pages.length ?? 0, rotation: session.result?.pages[0]?.rotation ?? null });
        };
        tx.onabort = () => { db.close(); reject(tx.error); };
    };
}));
const downloadPdf = async page => {
    await page.getByRole('button', { name: 'Exportar', exact: true }).click();
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Exportar todo', exact: true }).click();
    const stream = await (await pending).createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return PDFDocument.load(Buffer.concat(chunks));
};

try {
    const context = await createContext();
    try {
        const first = await open(context);
        await importFile(first, largePdf, 100);
        await waitStatus(first, 'saved');
        await first.waitForFunction(() => document.querySelectorAll('[data-deferred-preview] canvas').length > 0);
        const mountedCanvases = await first.locator('[data-deferred-preview] canvas').count();
        assert(mountedCanvases < 50, `Offscreen thumbnails must be deferred (${mountedCanvases}/100 mounted).`);
        await first.locator('.workspace-canvas').evaluate(element => { element.scrollTop = element.scrollHeight; });
        await first.waitForFunction(() => Boolean([...document.querySelectorAll('[data-deferred-preview]')].at(-1)?.querySelector('canvas')));
        assert(await first.locator('[data-deferred-preview] canvas').count() < 50);
        await first.locator('.workspace-canvas').evaluate(element => { element.scrollTop = 0; });
        const second = await open(context);
        assert.equal(await second.locator('.document-card').count(), 100, 'Restore all pages from disk.');
        await first.getByRole('button', { name: 'Rotar', exact: true }).first().click();
        await waitStatus(first, 'saved');
        const winning = await snapshot(first);
        assert.equal(winning.rotation, 90);
        await waitStatus(second, 'conflict');
        await second.getByRole('button', { name: 'Rotar', exact: true }).first().click();
        assert.equal((await downloadPdf(second)).getPageCount(), 100, 'Conflicted work remains exportable.');
        assert.deepEqual(await snapshot(second), winning, 'A conflicted tab must never replace the winning session.');
        await second.reload();
        await waitStatus(second, 'saved');
        assert.deepEqual(await snapshot(second), winning);
        await second.close();

        // Exercise the actual production service worker, not the dev server.
        await first.evaluate(() => navigator.serviceWorker.ready);
        await first.reload();
        await waitStatus(first, 'saved');
        await first.waitForLoadState('networkidle');
        await first.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
        // Removing the real server tests the cache fallback without relying on
        // an engine's offline-emulation implementation (WebKit differs here).
        if (ownedServer) await ownedServer.stop();
        else await context.setOffline(true);
        await first.reload();
        await waitStatus(first, 'saved');
        assert.equal(await first.locator('.document-card').count(), 100);
        assert.equal((await downloadPdf(first)).getPageCount(), 100, 'Warm offline session must remain exportable.');
        if (ownedServer) await ownedServer.restart();
        else await context.setOffline(false);
        console.log(JSON.stringify({ browserKind, restore: true, conflictIsolation: true, deferredThumbnails: mountedCanvases, offlineRestoreAndExport: true }));
    } finally { await context.close(); }

    const quotaContext = await createContext();
    try {
        const page = await open(quotaContext);
        await importFile(page, smallPdf, 1);
        await waitStatus(page, 'saved');
        const original = await snapshot(page);
        await page.evaluate(() => {
            const put = IDBObjectStore.prototype.put;
            IDBObjectStore.prototype.put = function(...args) {
                if (args[1] === 'current') throw new DOMException('Synthetic storage quota failure', 'QuotaExceededError');
                return put.apply(this, args);
            };
            window.restoreWorkbenchPut = () => { IDBObjectStore.prototype.put = put; };
        });
        await page.getByRole('button', { name: 'Rotar', exact: true }).first().click();
        await waitStatus(page, 'error');
        assert(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true }))), 'Failed saves must warn even with persistence enabled.');
        assert.deepEqual(await snapshot(page), original, 'Failed saves must roll back their revision too.');
        await page.evaluate(() => window.restoreWorkbenchPut());
        await page.getByRole('button', { name: 'Reintentar', exact: true }).click();
        await waitStatus(page, 'saved');
        assert.equal((await snapshot(page)).rotation, 90);
        console.log(JSON.stringify({ browserKind, quotaRollback: true, retry: true }));
    } finally { await quotaContext.close(); }

    const cancellationContext = await createContext(false);
    try {
        const page = await open(cancellationContext);
        const fixture = await makePdf(20);
        await page.locator('input[type=file]').first().setInputFiles(Array.from({ length: 20 }, (_, index) => ({ ...fixture, name: `synthetic-${index}.pdf` })));
        await page.locator('[data-operation-status]').getByRole('button', { name: 'Cancelar', exact: true }).click();
        await page.locator('[data-operation-status]').waitFor({ state: 'hidden' });
        assert.equal(await page.locator('.document-card').count(), 0, 'Cancelled imports must not commit partial batches.');
        await importFile(page, largePdf, 100);
        let downloads = 0;
        page.on('download', () => { downloads += 1; });
        await page.getByRole('button', { name: 'Exportar', exact: true }).click();
        await page.getByRole('button', { name: 'Exportar todo', exact: true }).click();
        await page.locator('[data-operation-status]').getByRole('button', { name: 'Cancelar', exact: true }).click();
        await page.locator('[data-operation-status]').waitFor({ state: 'hidden' });
        assert.equal(downloads, 0, 'A cancelled export must not download a partial result.');
        assert.equal(await page.locator('.document-card').count(), 100);
        // Verify the closing guard is installed even without persistence.
        assert(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true }))));
        assert.equal((await downloadPdf(page)).getPageCount(), 100, 'Editor must recover after cancellation.');
        console.log(JSON.stringify({ browserKind, importCancellation: true, exportCancellation: true, closingGuard: true, recovery: true }));
    } finally { await cancellationContext.close(); }

    const deniedContext = await browser.newContext({ locale: 'es-ES' });
    try {
        await deniedContext.addInitScript(() => {
            Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Synthetic storage denial', 'SecurityError'); } });
        });
        const page = await deniedContext.newPage();
        page.on('pageerror', error => failures.push(error.message));
        await page.goto(baseUrl);
        await waitStatus(page, 'disabled');
        await importFile(page, smallPdf, 1);
        assert.equal((await downloadPdf(page)).getPageCount(), 1, 'Denied preference storage must not break in-memory editing.');
        console.log(JSON.stringify({ browserKind, deniedStorageFallback: true }));
    } finally { await deniedContext.close(); }

    // One visual inspection batch for both screen classes, using only fixtures.
    if (process.env.WORKBENCH_SCREENSHOT_DIR && browserKind === 'chromium') {
        await mkdir(process.env.WORKBENCH_SCREENSHOT_DIR, { recursive: true });
        const context = await createContext(true, 'de');
        try {
            const page = await open(context);
            await importFile(page, smallPdf, 1);
            await waitStatus(page, 'saved');
            const notification = page.locator('[role=alert] button');
            if (await notification.count()) await notification.first().click();
            for (const width of [1440, 390]) {
                await page.setViewportSize({ width, height: 1000 });
                assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'No horizontal overflow.');
                await page.screenshot({ path: `${process.env.WORKBENCH_SCREENSHOT_DIR}/workbench-${width}.png` });
            }
        } finally { await context.close(); }
    }
    assert.equal(failures.length, 0, failures.join('\n'));
    assert.equal(unexpectedRequests.length, 0, 'Documents and diagnostics must stay local.');
} finally { await browser.close(); await ownedServer?.stop(); }
