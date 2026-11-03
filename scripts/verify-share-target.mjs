import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { startLocalTestServer } from './local-test-server.mjs';

const engines = { chromium, firefox, webkit };
const browserKind = process.env.BROWSER_KIND ?? 'chromium';
assert(browserKind in engines, 'Unsupported browser engine.');
const server = await startLocalTestServer('preview');
let browser;
try {
    browser = await engines[browserKind].launch({ headless: true });
    const context = await browser.newContext({ locale: 'es-ES' });
    const page = await context.newPage();
    const unexpectedRequests = [];
    // Observe real requests instead of routing them: the service worker must handle the POST.
    page.on('request', request => {
        if (new URL(request.url()).origin !== server.url) unexpectedRequests.push(request.url());
    });
    await page.goto(server.url);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    const source = await PDFDocument.create();
    source.addPage([300, 300]);
    await page.evaluate(encoded => {
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = new URL('share-target', location.href).href;
        form.enctype = 'multipart/form-data';
        const input = document.createElement('input');
        input.type = 'file';
        input.name = 'files';
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(encoded)], 'shared-regression.pdf', { type: 'application/pdf' }));
        input.files = transfer.files;
        form.append(input);
        document.body.append(form);
        form.requestSubmit();
    }, [...await source.save()]);
    await page.waitForFunction(() => document.querySelectorAll('.document-card').length === 1 && !document.querySelector('[data-operation-status]'), undefined, { timeout: 60000 });
    const remaining = await page.evaluate(async () => (await (await caches.open('pageforge-share-target')).keys()).length);
    assert.equal(remaining, 0, 'Consumed shared files must leave the handoff cache.');
    assert(!new URL(page.url()).searchParams.has('shared-files'));
    assert.deepEqual(unexpectedRequests, []);
    console.log(JSON.stringify({ browserKind, realServiceWorkerHandoff: true, importedOnce: true, handoffCleared: true, unexpectedRequests: 0 }));
} finally {
    await browser?.close();
    await server.stop();
}
