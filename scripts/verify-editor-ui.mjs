import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const modulePath = process.env.PLAYWRIGHT_MODULE_PATH;
const imported = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright-core');
const playwright = imported.default ?? imported;
const baseUrl = process.env.CONTENT_TEST_URL ?? 'http://127.0.0.1:5173';
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname), 'Use a localhost test server.');
const privateFixture = process.argv[2];
let bytes;
if (privateFixture) bytes = await readFile(privateFixture);
else {
    const source = await PDFDocument.create();
    const font = await source.embedFont(StandardFonts.Helvetica);
    const page = source.addPage([420, 550]);
    page.drawRectangle({ x: 0, y: 0, width: 420, height: 550, color: rgb(0.8, 0.9, 1) });
    page.drawText('Café original', { x: 60, y: 450, size: 20, font });
    page.drawText('Neighbor intact', { x: 60, y: 390, size: 20, font });
    bytes = Buffer.from(await source.save());
}
const browser = await playwright.chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH, headless: true });
try {
    for (const width of [1440, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 900 }, locale: 'es-ES' });
        const errors = [];
        const rewriteErrors = [];
        const wasmErrors = [];
        const unexpectedRequests = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => {
            if (message.text().includes('Error previewing PDF')) rewriteErrors.push(message.text());
            if (/ICCBased.*LinkError|function import requires a callable/.test(message.text())) wasmErrors.push(message.text());
        });
        await page.route('**/*', async route => {
            const request = route.request();
            if (new URL(request.url()).origin !== new URL(baseUrl).origin || !['GET', 'HEAD'].includes(request.method())) {
                unexpectedRequests.push(request.method());
                await route.abort();
            } else await route.continue();
        });
        await page.goto(baseUrl);
        assert.equal(await page.getByRole('checkbox', { name: /Guardar mi sesión/ }).isChecked(), false, 'Session persistence must be opt-in.');
        await page.getByRole('button', { name: 'Empezar', exact: true }).click();
        await page.locator('input[type=file]').first().setInputFiles({ name: 'local-fixture.pdf', mimeType: 'application/pdf', buffer: bytes });
        const openEditor = () => page.getByRole('button', { name: 'Editar página', exact: true }).first().click({ timeout: 30000 });
        await openEditor();
        await page.getByRole('button', { name: 'Editar contenido', exact: true }).click();
        await page.getByRole('button', { name: /^Elemento de texto:/ }).first().click({ timeout: 30000 });
        await page.getByRole('button', { name: 'Editar texto', exact: true }).click();
        const input = page.getByRole('textbox', { name: 'Editar texto', exact: true });
        const original = await input.inputValue();
        const canvas = page.locator('[role=dialog] canvas').first();
        const initialPixels = await canvas.evaluate(element => element.toDataURL());
        const save = page.getByRole('button', { name: 'Guardar', exact: true });
        const waitSavedPreview = async () => {
            try { await page.waitForFunction(() => !document.querySelector('[role=dialog] button[aria-label="Guardar"]')?.disabled); }
            catch { throw new Error(`Preview did not validate: ${JSON.stringify(await page.locator('[role=alert]').allTextContents())}`); }
        };
        for (let index = 0; index < 12; index++) await input.fill(`prueba${index}`);
        await input.fill('prueba');
        await waitSavedPreview();
        assert(await input.evaluate(element => document.activeElement === element), 'Live rendering must retain keyboard focus.');
        assert.notEqual(await canvas.evaluate(element => element.toDataURL()), initialPixels);
        await input.press('Escape');
        await page.waitForFunction(expected => document.querySelector('[role=dialog] canvas')?.toDataURL() === expected, initialPixels);
        await page.getByRole('button', { name: 'Editar texto', exact: true }).click();
        await input.fill('😀');
        await page.waitForFunction(() => Boolean(document.querySelector('[role=dialog] [role=alert]')));
        assert(await save.isDisabled(), 'Unsupported edits must not be saved.');
        const beforeIdle = rewriteErrors.length;
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 600)));
        assert.equal(rewriteErrors.length, beforeIdle, 'An unchanged rejected edit must not retry continuously.');
        await input.press('Escape');
        await waitSavedPreview();
        await page.getByRole('button', { name: 'Editar texto', exact: true }).click();
        await input.fill('p');
        await input.press('Enter');
        await waitSavedPreview();
        if (!privateFixture && process.env.CONTENT_SCREENSHOT_DIR) {
            await page.screenshot({ path: `${process.env.CONTENT_SCREENSHOT_DIR}/rewrite-ui-${width}.png` });
        }
        await save.click();
        await openEditor();
        await waitSavedPreview();
        await page.getByRole('button', { name: 'Editar contenido', exact: true }).click();
        await page.getByRole('button', { name: /^Elemento de texto:/ }).first().click();
        await page.getByRole('button', { name: 'Editar texto', exact: true }).click();
        assert((await input.inputValue()) === 'p', 'Saved content must survive editor reopening.');
        await input.press('Escape');
        await waitSavedPreview();
        await save.click();
        await page.getByRole('button', { name: 'Exportar', exact: true }).click();
        const downloadPromise = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Exportar todo', exact: true }).click();
        const download = await downloadPromise;
        const stream = await download.createReadStream();
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const output = Buffer.concat(chunks);
        assert((await PDFDocument.load(output)).getPageCount() > 0);
        const canReeditExport = await page.evaluate(async encoded => {
            const { getPdfDocument } = await import('/src/utils/pdfjs.ts');
            const { parseContentPage } = await import('/src/features/content-editor/parseContentPage.ts');
            const { createRewrittenPreview } = await import('/src/features/content-editor/createRewrittenPreview.ts');
            const task = await getPdfDocument({ data: Uint8Array.from(atob(encoded), character => character.charCodeAt(0)) });
            let checkTask;
            try {
                const document = await task.promise;
                const first = await document.getPage(1);
                const parsed = await parseContentPage(document, 1, first.rotate, 800, 800, []);
                const target = parsed.blocks.find(block => block.type === 'text' && block.text === 'p');
                if (!target) return false;
                const rewritten = await createRewrittenPreview(document, 1, [{ ...target, text: 'pp', isDirty: true }]);
                checkTask = await getPdfDocument({ data: rewritten });
                const text = await (await (await checkTask.promise).getPage(1)).getTextContent();
                return text.items.some(item => 'str' in item && item.str === 'pp');
            } finally { if (checkTask) await checkTask.destroy(); await task.destroy(); }
        }, output.toString('base64'));
        assert(canReeditExport, 'The actual exported PDF must support another content edit.');
        assert.equal(errors.length, 0, errors.join('\n'));
        assert.equal(wasmErrors.length, 0, 'No incompatible WASM warnings are allowed.');
        assert.equal(unexpectedRequests.length, 0, 'Document editing must remain local.');
        assert(original.length > 0);
        console.log(JSON.stringify({ width, privateFixture: Boolean(privateFixture), livePreview: true, cancellation: true, errorRecovery: true, savedReopen: true, exportReedit: true, unexpectedRequests: 0, wasmErrors: 0 }));
        await page.close();
    }
} finally { await browser.close(); }
