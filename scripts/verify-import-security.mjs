import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { startLocalTestServer } from './local-test-server.mjs';

const engines = { chromium, firefox, webkit };
const browserKind = process.env.BROWSER_KIND ?? 'chromium';
assert(browserKind in engines, 'Unsupported browser engine.');
const server = await startLocalTestServer();
let browser;
try {
    browser = await engines[browserKind].launch({ headless: true });
    const page = await browser.newPage();
    const unexpectedRequests = [];
    await page.route('**/*', route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== server.url || url.pathname.includes('security-probe')) {
            unexpectedRequests.push(url.pathname);
            return route.abort();
        }
        return route.continue();
    });
    await page.goto(server.url);
    const isolation = await page.evaluate(async () => {
        const { withRenderHost } = await import('/src/features/import/renderPagesToPdf.ts');
        const originalColor = getComputedStyle(document.body).color;
        await withRenderHost(async host => {
            if (host.ownerDocument === document) throw new Error('Rendering still shares the application document.');
            const style = host.ownerDocument.createElement('style');
            style.textContent = 'body { color: rgb(1, 2, 3) !important; background-image: url(/security-probe-css) }';
            const image = host.ownerDocument.createElement('img');
            image.src = '/security-probe-image';
            image.setAttribute('onerror', "parent.document.body.dataset.compromised = 'true'");
            const script = host.ownerDocument.createElement('script');
            script.textContent = "parent.document.body.dataset.compromised = 'true'";
            host.append(style, image, script);
            await new Promise(resolve => setTimeout(resolve, 250));
            if (getComputedStyle(document.body).color !== originalColor || document.body.dataset.compromised) throw new Error('Document markup escaped isolation.');
        });
        if (document.querySelector('iframe[title="Office document renderer"]')) throw new Error('Temporary frame leaked.');
        const { checkSavedAssets } = await import('/src/test/savedAssetsHarness.ts');
        return { sandboxIsolation: true, ...await checkSavedAssets() };
    });
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="doc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>Safe synthetic document</w:t></w:r></w:p><w:altChunk r:id="html"/></w:body></w:document>');
    zip.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="html" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="active.html"/></Relationships>');
    zip.file('word/active.html', '<script>parent.document.body.dataset.compromised="true"</script><img src="https://example.com/security-probe-altchunk">');
    const convert = bytes => page.evaluate(async encoded => {
        const { convertDocxToPdf } = await import('/src/features/import/officeImport.ts');
        const bytes = await convertDocxToPdf(new Uint8Array(encoded).buffer, { maxPages: 5, createPageLimitError: () => new Error('Page limit') });
        if (document.body.dataset.compromised) throw new Error('Embedded HTML ran.');
        return [...bytes];
    }, [...bytes]);
    const output = await convert(await zip.generateAsync({ type: 'uint8array' }));
    assert.equal((await PDFDocument.load(new Uint8Array(output))).getPageCount(), 1);
    zip.file('word/styles.xml', '<!DOCTYPE styles [<!ENTITY x "expanded">]><styles/>');
    await assert.rejects(convert(await zip.generateAsync({ type: 'uint8array' })), /declarations and entities/);
    assert.deepEqual(unexpectedRequests, []);
    console.log(JSON.stringify({ browserKind, ...isolation, activeHtmlDisabled: true, auxiliaryXmlRejected: true, unexpectedRequests: 0 }));
} finally {
    await browser?.close();
    await server.stop();
}
