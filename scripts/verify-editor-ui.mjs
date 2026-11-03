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
const browserKind = process.env.BROWSER_KIND ?? 'chromium';
assert(['chromium', 'firefox', 'webkit'].includes(browserKind), 'Unsupported browser engine.');
const browser = await playwright[browserKind].launch({ executablePath: browserKind === 'chromium' ? process.env.CHROME_EXECUTABLE_PATH : undefined, headless: true });
try {
    const blankPdf = await PDFDocument.create();
    blankPdf.addPage([420, 550]);
    const blankPage = await browser.newPage({ locale: 'es-ES' });
    blankPage.setDefaultTimeout(60_000);
    try {
        await blankPage.goto(baseUrl);
        await blankPage.waitForFunction(() => { const status = document.querySelector('[data-session-status]'); return status && status.dataset.sessionStatus !== 'loading'; });
        await blankPage.locator('input[type=file]').first().setInputFiles({ name: 'blank.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await blankPdf.save()) });
        // Export stays disabled until the imported page is in the workspace.
        await blankPage.locator('.document-card').first().waitFor({ timeout: 90000 });
        await blankPage.getByRole('button', { name: 'Exportar', exact: true }).click();
        const blankDownloadPromise = blankPage.waitForEvent('download');
        await blankPage.getByRole('button', { name: 'Exportar todo', exact: true }).click();
        const blankDownload = await blankDownloadPromise;
        const blankStream = await blankDownload.createReadStream();
        const blankChunks = [];
        for await (const chunk of blankStream) blankChunks.push(chunk);
        assert.equal((await PDFDocument.load(Buffer.concat(blankChunks))).getPageCount(), 1, 'A blank source page must export.');
    } finally { await blankPage.close(); }
    for (const width of [1440, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 900 }, locale: 'es-ES' });
        page.setDefaultTimeout(60_000);
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
        await page.waitForFunction(() => { const status = document.querySelector('[data-session-status]'); return status && status.dataset.sessionStatus !== 'loading'; });
        assert.equal(await page.getByRole('switch', { name: /Guardar mi sesión/ }).isChecked(), false, 'Session persistence must be opt-in.');
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
        if (!privateFixture) {
            await openEditor();
            const annotationCanvas = page.locator('canvas[aria-label^="Lienzo de anotaciones"]');
            const fillButton = page.getByRole('button', { name: 'Rellenar forma' });
            const settleCanvas = () => annotationCanvas.evaluate(async element => {
                // Changing tools can reflow the mobile toolbar and resize the
                // fitted canvas. Measure only after that layout has settled.
                let previous = '';
                let stableFrames = 0;
                for (let frame = 0; frame < 120; frame++) {
                    await new Promise(requestAnimationFrame);
                    const box = element.getBoundingClientRect();
                    const current = [box.x, box.y, box.width, box.height].map(value => value.toFixed(2)).join(',');
                    stableFrames = current === previous ? stableFrames + 1 : 0;
                    if (stableFrames >= 3) return;
                    previous = current;
                }
                throw new Error('Annotation canvas geometry did not settle.');
            });
            const waitPixel = (x, y, offsetX, expected) => page.waitForFunction(([x, y, offsetX, expected]) => {
                const element = document.querySelector('canvas[aria-label^="Lienzo de anotaciones"]');
                const pixel = element?.getContext('2d').getImageData(Math.round(element.width * x) + offsetX, Math.round(element.height * y), 1, 1).data;
                return Boolean(pixel) && (pixel[0] > 200 && pixel[1] < 80 && pixel[2] < 80) === expected;
            }, [x, y, offsetX, expected], { timeout: 15000 });
            const dragOnCanvas = async (fromX, fromY, toX, toY) => {
                await annotationCanvas.scrollIntoViewIfNeeded();
                await settleCanvas();
                const box = await annotationCanvas.boundingBox();
                assert(box, 'The annotation canvas must be visible.');
                await annotationCanvas.evaluate(element => {
                    element.addEventListener('pointerup', event => {
                        const bounds = element.getBoundingClientRect();
                        element.dataset.gestureX = String((event.clientX - bounds.left) * element.width / bounds.width);
                        element.dataset.gestureY = String((event.clientY - bounds.top) * element.height / bounds.height);
                    }, { once: true, capture: true });
                });
                await page.mouse.move(box.x + box.width * fromX, box.y + box.height * fromY);
                await page.mouse.down();
                await page.mouse.move(box.x + box.width * toX, box.y + box.height * toY, { steps: 5 });
                await page.mouse.up();
                // Engines round fractional CSS pointer positions differently,
                // which is amplified by the fitted mobile canvas scale.
                return annotationCanvas.evaluate(element => ({ x: Number(element.dataset.gestureX), y: Number(element.dataset.gestureY) }));
            };
            const pressShortcut = async key => {
                // Shortcuts are ignored while a form control (e.g. a colour picker) has focus.
                await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
                await page.keyboard.press(key);
            };
            const drawFilledShape = async (tool, top, bottom) => {
                await page.getByRole('button', { name: tool, exact: true }).click();
                if (await fillButton.getAttribute('aria-pressed') !== 'true') await fillButton.click();
                await page.getByLabel('Color de relleno').fill('#ff0000');
                await annotationCanvas.scrollIntoViewIfNeeded();
                await annotationCanvas.evaluate(async element => {
                    // Changing tools can reflow the mobile toolbar and resize the
                    // fitted canvas. Measure only after that layout has settled.
                    let previous = '';
                    let stableFrames = 0;
                    for (let frame = 0; frame < 120; frame++) {
                        await new Promise(requestAnimationFrame);
                        const box = element.getBoundingClientRect();
                        const current = [box.x, box.y, box.width, box.height].map(value => value.toFixed(2)).join(',');
                        stableFrames = current === previous ? stableFrames + 1 : 0;
                        if (stableFrames >= 3) return;
                        previous = current;
                    }
                    throw new Error('Annotation canvas geometry did not settle.');
                });
                const box = await annotationCanvas.boundingBox();
                assert(box, 'The annotation canvas must be visible.');
                await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * top);
                assert(await annotationCanvas.evaluate((element, position) => {
                    const box = element.getBoundingClientRect();
                    return document.elementFromPoint(box.x + box.width * 0.45, box.y + box.height * position) === element;
                }, top), 'Shape start must be inside the visible annotation canvas.');
                await page.mouse.down();
                await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * bottom, { steps: 5 });
                await page.mouse.up();
                // React/canvas painting is asynchronous, especially in WebKit.
                // Wait for the required pixel, not a browser-dependent delay.
                await page.waitForFunction(position => {
                    const element = document.querySelector('canvas[aria-label^="Lienzo de anotaciones"]');
                    if (!element) return false;
                    const pixel = element.getContext('2d').getImageData(Math.round(element.width * 0.55), Math.round(element.height * position), 1, 1).data;
                    return pixel[0] > 200 && pixel[1] < 80 && pixel[2] < 80;
                }, (top + bottom) / 2, { timeout: 5000 });
                const pixel = await annotationCanvas.evaluate((element, position) => {
                    const x = Math.round(element.width * 0.55);
                    const y = Math.round(element.height * position);
                    return [...element.getContext('2d').getImageData(x, y, 1, 1).data];
                }, (top + bottom) / 2);
                assert(pixel[0] > 200 && pixel[1] < 80 && pixel[2] < 80, `${tool} must render with a red fill.`);
            };
            await drawFilledShape('Rectángulo', 0.42, 0.58);
            // The drawn rectangle stays selected with its tool active; turning fill
            // off for the next shape must not unfill it.
            await fillButton.click();
            assert.equal(await fillButton.getAttribute('aria-pressed'), 'false');
            await page.waitForTimeout(100);
            const keptFill = await annotationCanvas.evaluate(element => [...element.getContext('2d')
                .getImageData(Math.round(element.width * 0.55), Math.round(element.height * 0.5), 1, 1).data]);
            assert(keptFill[0] > 200 && keptFill[1] < 80 && keptFill[2] < 80, 'Toggling fill for the next shape must keep the drawn rectangle filled.');
            await drawFilledShape('Círculo', 0.66, 0.82);

            // Undo and redo inside the page editor.
            await pressShortcut('ControlOrMeta+z');
            await waitPixel(0.55, 0.74, 0, false);
            await pressShortcut('ControlOrMeta+y');
            await waitPixel(0.55, 0.74, 0, true);

            // Duplicate the selected rectangle; the copy is offset to the right.
            await page.getByRole('button', { name: 'Seleccionar', exact: true }).click();
            await dragOnCanvas(0.55, 0.5, 0.55, 0.5);
            const duplicateProbe = await annotationCanvas.evaluate(element => {
                const y = Math.round(element.height * 0.5);
                const row = element.getContext('2d').getImageData(0, y, element.width, 1).data;
                let right = -1;
                for (let x = 0; x < element.width; x++) {
                    const offset = x * 4;
                    if (row[offset] > 200 && row[offset + 1] < 80 && row[offset + 2] < 80 && row[offset + 3] > 200) right = x;
                }
                if (right < 0) throw new Error('The original filled rectangle is missing.');
                return { x: right + 8, y };
            });
            const waitDuplicatePixel = expected => page.waitForFunction(({ point, expected }) => {
                const element = document.querySelector('canvas[aria-label^="Lienzo de anotaciones"]');
                const pixel = element?.getContext('2d').getImageData(point.x, point.y, 1, 1).data;
                return Boolean(pixel) && (pixel[0] > 200 && pixel[1] < 80 && pixel[2] < 80) === expected;
            }, { point: duplicateProbe, expected }, { timeout: 15000 });
            // Wait past the undo coalescing window so the duplicate is its own step.
            await page.waitForTimeout(500);
            await pressShortcut('ControlOrMeta+d');
            await waitDuplicatePixel(true);
            await page.waitForTimeout(500);
            await pressShortcut('ControlOrMeta+z');
            await waitDuplicatePixel(false);
            // Clicking to select added no undo step, so one more undo removes the circle.
            await pressShortcut('ControlOrMeta+z');
            await waitPixel(0.55, 0.74, 0, false);
            await pressShortcut('ControlOrMeta+y');
            await waitPixel(0.55, 0.74, 0, true);

            // Highlight: a translucent fill.
            await page.getByRole('button', { name: 'Resaltar', exact: true }).click();
            await dragOnCanvas(0.15, 0.2, 0.4, 0.26);
            await page.waitForFunction(() => {
                const element = document.querySelector('canvas[aria-label^="Lienzo de anotaciones"]');
                const pixel = element?.getContext('2d').getImageData(Math.round(element.width * 0.3), Math.round(element.height * 0.23), 1, 1).data;
                return Boolean(pixel) && pixel[0] > 200 && pixel[2] < 80 && pixel[3] > 40 && pixel[3] < 160;
            }, undefined, { timeout: 15000 });

            // Arrow: the head is filled with the stroke colour.
            await page.getByRole('button', { name: 'Flecha', exact: true }).click();
            const arrowEnd = await dragOnCanvas(0.15, 0.92, 0.45, 0.92);
            // Selection handles overlap the tip and their antialiasing differs
            // between engines. Inspect the arrow itself after deselecting it.
            await page.getByRole('button', { name: 'Seleccionar', exact: true }).click();
            await dragOnCanvas(0.05, 0.85, 0.05, 0.85);
            await page.waitForFunction(position => {
                const element = document.querySelector('canvas[aria-label^="Lienzo de anotaciones"]');
                const pixel = element?.getContext('2d').getImageData(Math.round(position.x) - 6, Math.round(position.y) + 1, 1, 1).data;
                return Boolean(pixel) && pixel[3] > 200 && pixel[0] < 80;
            }, arrowEnd, { timeout: 15000 });

            // A down/up pair can arrive before React commits a drawing frame.
            // Dispatch both in one task to keep this regression deterministic.
            await page.getByRole('button', { name: 'Rectángulo', exact: true }).click();
            if (await fillButton.getAttribute('aria-pressed') !== 'true') await fillButton.click();
            await page.getByLabel('Color de relleno').fill('#ff0000');
            await settleCanvas();
            await annotationCanvas.evaluate(element => {
                const bounds = element.getBoundingClientRect();
                const capture = element.setPointerCapture;
                const hasCapture = element.hasPointerCapture;
                // Synthetic events have no native active pointer to capture.
                element.setPointerCapture = () => {};
                element.hasPointerCapture = () => false;
                const event = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 17, pointerType: 'mouse', isPrimary: true, clientX: bounds.x + bounds.width * x, clientY: bounds.y + bounds.height * y });
                try {
                    element.dispatchEvent(event('pointerdown', 0.05, 0.34));
                    element.dispatchEvent(event('pointerup', 0.2, 0.4));
                } finally {
                    element.setPointerCapture = capture;
                    element.hasPointerCapture = hasCapture;
                }
            });
            await waitPixel(0.12, 0.37, 0, true);
            await save.click();
            await page.getByRole('button', { name: 'Exportar', exact: true }).click();
            const filledDownloadPromise = page.waitForEvent('download');
            await page.getByRole('button', { name: 'Exportar todo', exact: true }).click();
            const filledDownload = await filledDownloadPromise;
            const filledStream = await filledDownload.createReadStream();
            const filledChunks = [];
            for await (const chunk of filledStream) filledChunks.push(chunk);
            const filledOutput = Buffer.concat(filledChunks);
            const exportedFill = await page.evaluate(async encoded => {
                const { getPdfDocument } = await import('/src/utils/pdfjs.ts');
                const task = await getPdfDocument({ data: Uint8Array.from(atob(encoded), character => character.charCodeAt(0)) });
                try {
                    const pdfDocument = await task.promise;
                    const pdfPage = await pdfDocument.getPage(1);
                    const viewport = pdfPage.getViewport({ scale: 1 });
                    const outputCanvas = document.createElement('canvas');
                    outputCanvas.width = Math.ceil(viewport.width);
                    outputCanvas.height = Math.ceil(viewport.height);
                    const context = outputCanvas.getContext('2d');
                    await pdfPage.render({ canvasContext: context, canvas: outputCanvas, viewport }).promise;
                    const fills = [0.5, 0.74].map(y => [...context.getImageData(Math.round(outputCanvas.width * 0.55), Math.round(outputCanvas.height * y), 1, 1).data]);
                    const highlight = [...context.getImageData(Math.round(outputCanvas.width * 0.3), Math.round(outputCanvas.height * 0.23), 1, 1).data];
                    return { fills, highlight };
                } finally { await task.destroy(); }
            }, filledOutput.toString('base64'));
            assert(exportedFill.fills.every(pixel => pixel[0] > 200 && pixel[1] < 80 && pixel[2] < 80), 'Rectangle and circle fills must survive PDF export.');
            // Yellow multiplied over the light blue page lowers blue but keeps the page readable.
            const [red, , blue] = exportedFill.highlight;
            assert(red > 180 && blue < 210 && blue > 100, `The highlight must export as a translucent yellow: ${exportedFill.highlight}`);
        }
        assert.equal(errors.length, 0, errors.join('\n'));
        assert.equal(wasmErrors.length, 0, 'No incompatible WASM warnings are allowed.');
        assert.equal(unexpectedRequests.length, 0, 'Document editing must remain local.');
        assert(original.length > 0);
        console.log(JSON.stringify({ width, privateFixture: Boolean(privateFixture), livePreview: true, cancellation: true, errorRecovery: true, savedReopen: true, exportReedit: true, unexpectedRequests: 0, wasmErrors: 0 }));
        await page.close();
    }
} finally { await browser.close(); }
