import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Optional local integration check. The supplied document never leaves localhost.
const fixturePath = process.argv[2];
if (!fixturePath) throw new Error('Usage: node scripts/verify-content-rewriting.mjs <local.pdf>');
const modulePath = process.env.PLAYWRIGHT_MODULE_PATH;
const playwrightModule = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright-core');
const playwright = playwrightModule.default ?? playwrightModule;
const browser = await playwright.chromium.launch({
    executablePath: process.env.CHROME_EXECUTABLE_PATH,
    headless: true,
});
const baseUrl = process.env.CONTENT_TEST_URL ?? 'http://127.0.0.1:5173';
const origin = new URL(baseUrl).origin;
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseUrl).hostname)) {
    await browser.close();
    throw new Error('Private fixture checks require a localhost Vite server.');
}
try {
    const page = await browser.newPage();
    const unexpectedRequests = [];
    const runtimeFailures = [];
    page.on('pageerror', error => runtimeFailures.push(error.name));
    page.on('console', message => {
        if (/ICCBased.*LinkError|function import requires a callable/.test(message.text())) runtimeFailures.push('WASM linkage failure');
    });
    await page.route('**/*', async route => {
        const request = route.request();
        if (new URL(request.url()).origin !== origin || !['GET', 'HEAD'].includes(request.method())) {
            unexpectedRequests.push({ method: request.method(), origin: new URL(request.url()).origin });
            await route.abort();
        } else await route.continue();
    });
    await page.goto(baseUrl);
    const data = await readFile(fixturePath);
    const results = await page.evaluate(async encoded => {
        const { getPdfDocument } = await import('/src/utils/pdfjs.ts');
        const { parseContentPage } = await import('/src/features/content-editor/parseContentPage.ts');
        const { createRewrittenPreview } = await import('/src/features/content-editor/createRewrittenPreview.ts');
        const sourceBytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
        const sourceTask = await getPdfDocument({ data: sourceBytes });
        const source = await sourceTask.promise;
        const summary = [];
        try {
            for (let pageNumber = 1; pageNumber <= source.numPages; pageNumber++) {
                const sourcePage = await source.getPage(pageNumber);
                const parsed = await parseContentPage(source, pageNumber, sourcePage.rotate, 800, 800, []);
                const projectText = value => value.normalize('NFKC').replaceAll(/\s/g, '');
                const originalText = (await sourcePage.getTextContent()).items.flatMap(item => 'str' in item ? [item.str] : []).join('');
                const originalGlyphs = projectText(originalText);
                const record = { page: pageNumber, text: 0, images: 0, passed: 0, failures: [], batchDeletionRemaining: null };
                for (const block of parsed.blocks) {
                    if (block.type === 'text') record.text++; else record.images++;
                    const operations = block.type === 'text' ? ['delete', 'replace', 'move'] : ['delete', 'move'];
                    for (const operation of operations) {
                        const edit = { ...block, isDirty: true };
                        if (operation === 'delete') edit.deleted = true;
                        if (operation === 'replace') edit.text = 'p';
                        if (operation === 'move') edit.pdfX += 3;
                        let checkTask;
                        try {
                            const output = await createRewrittenPreview(source, pageNumber, [edit]);
                            checkTask = await getPdfDocument({ data: output });
                            const checkDoc = await checkTask.promise;
                            const checkPage = await checkDoc.getPage(1);
                            const text = await checkPage.getTextContent();
                            const outputGlyphs = projectText(text.items.flatMap(item => 'str' in item ? [item.str] : []).join(''));
                            if (block.type === 'text') {
                                const selectedGlyphs = projectText(block.originalText);
                                const expectedLength = originalGlyphs.length - (operation === 'move' ? 0 : selectedGlyphs.length) + (operation === 'replace' ? 1 : 0);
                                if (outputGlyphs.length !== expectedLength) throw new Error('Rewriting changed an unexpected number of source characters.');
                                if (operation === 'replace') {
                                    const countP = value => [...value].filter(character => character === 'p').length;
                                    if (countP(outputGlyphs) !== countP(originalGlyphs) - countP(selectedGlyphs) + 1) throw new Error('Replacement character count is incorrect.');
                                    if (!text.items.some(item => 'str' in item && item.str.startsWith('p') && Math.abs(item.transform[4] - edit.pdfX) < 1.25 && Math.abs(item.transform[5] - edit.pdfY) < 1.25)) {
                                        throw new Error('Replacement text shifted away from the selected baseline.');
                                    }
                                }
                                if (operation === 'move' && !text.items.some(item => 'str' in item && Math.abs(item.transform[4] - edit.pdfX) < 1.25 && Math.abs(item.transform[5] - edit.pdfY) < 1.25)) {
                                    throw new Error('Moved text is not at the requested position.');
                                }
                            }
                            // Rendering catches malformed streams and font/WASM integration errors.
                            const viewport = checkPage.getViewport({ scale: 0.35 });
                            const canvas = document.createElement('canvas');
                            canvas.width = Math.ceil(viewport.width);
                            canvas.height = Math.ceil(viewport.height);
                            await checkPage.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
                            record.passed++;
                        } catch (error) {
                            record.failures.push({ id: block.id, type: block.type, operation, message: error.message });
                        } finally { if (checkTask) await checkTask.destroy(); }
                    }
                }
                let batchTask;
                try {
                    const edits = parsed.blocks.filter(block => block.type === 'text').map(block => ({ ...block, isDirty: true, deleted: true }));
                    const output = await createRewrittenPreview(source, pageNumber, edits);
                    batchTask = await getPdfDocument({ data: output });
                    const text = await (await (await batchTask.promise).getPage(1)).getTextContent();
                    record.batchDeletionRemaining = text.items.filter(item => 'str' in item && item.str.trim()).length;
                } catch (error) {
                    record.failures.push({ operation: 'batch-delete', message: error.message });
                } finally { if (batchTask) await batchTask.destroy(); }
                summary.push(record);
            }
        } finally { await sourceTask.destroy(); }
        return summary;
    }, data.toString('base64'));
    console.log(JSON.stringify({ results, unexpectedRequests, runtimeFailures }, null, 2));
    assert.equal(unexpectedRequests.length, 0, 'Document processing must stay local.');
    assert.equal(runtimeFailures.length, 0, 'Rendering must use compatible WASM and have no uncaught errors.');
    assert(results.every(result => !result.failures.length && result.batchDeletionRemaining === 0), 'Some content operations failed.');
} finally { await browser.close(); }
