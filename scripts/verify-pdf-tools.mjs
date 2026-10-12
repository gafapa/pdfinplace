import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { decodePDFRawStream, PDFDocument, PDFName, PDFNumber, PDFRawStream, StandardFonts } from 'pdf-lib';
import { chromium, firefox, webkit } from 'playwright';
import { startLocalTestServer } from './local-test-server.mjs';

// Fills a form, redacts text and compresses images through the UI, then
// inspects the exported PDFs: values written, redacted text gone from the
// file bytes, and images downscaled.
const engines = { chromium, firefox, webkit };
const browserKind = process.env.BROWSER_KIND ?? 'chromium';
assert(browserKind in engines, 'Unsupported browser engine.');

/** Page 1: a form. Page 2: a secret line. Page 3: a large grainy image. */
const makeFixture = async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const formPage = document.addPage([595.28, 841.89]);
    formPage.drawText('Application form', { x: 40, y: 780, size: 18, font });
    const form = document.getForm();
    const name = form.createTextField('applicant.name');
    name.addToPage(formPage, { x: 40, y: 600, width: 300, height: 40 });
    form.createCheckBox('consent').addToPage(formPage, { x: 40, y: 500, width: 30, height: 30 });

    const secretPage = document.addPage([595.28, 841.89]);
    secretPage.drawText('PUBLIC HEADING', { x: 40, y: 780, size: 18, font });
    secretPage.drawText('TOPSECRET', { x: 40, y: 420, size: 28, font });

    const imagePage = document.addPage([595.28, 841.89]);
    const width = 2400;
    const height = 1800;
    const pixels = new Uint8Array(width * height * 3);
    let seed = 7;
    for (let index = 0; index < pixels.length; index += 1) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const position = Math.floor(index / 3);
        pixels[index] = 120 + (60 * Math.sin((position % width) / 41)) + ((seed % 15) - 7);
    }
    const image = document.context.register(PDFRawStream.of(document.context.obj({
        Type: 'XObject', Subtype: 'Image', Width: width, Height: height, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode',
    }), new Uint8Array(deflateSync(pixels))));
    const imageName = imagePage.node.newXObject('Photo', image);
    const { pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } = await import('pdf-lib');
    imagePage.pushOperators(pushGraphicsState(), concatTransformationMatrix(500, 0, 0, 375, 47, 300), drawObject(imageName), popGraphicsState());
    return Buffer.from(await document.save());
};

const readDownload = async download => {
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    return Buffer.concat(chunks);
};
const streamText = async bytes => {
    const document = await PDFDocument.load(bytes);
    return document.context.enumerateIndirectObjects().flatMap(([, object]) => {
        if (!(object instanceof PDFRawStream)) return [];
        try {
            return [Buffer.from(decodePDFRawStream(object).decode()).toString('latin1')];
        } catch {
            return [];
        }
    }).join('\n');
};
const hex = text => Buffer.from(text, 'latin1').toString('hex').toUpperCase();
// Local review aid: set TOOLS_SCREENSHOT_DIR to keep screenshots of each step.
const screenshot = async (page, name) => {
    if (!process.env.TOOLS_SCREENSHOT_DIR) return;
    await mkdir(process.env.TOOLS_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: `${process.env.TOOLS_SCREENSHOT_DIR}/${browserKind}-${name}.png` });
};

const server = await startLocalTestServer('preview');
const browser = await engines[browserKind].launch({ headless: true }).catch(async error => {
    await server.stop();
    throw error;
});
const failures = [];
try {
    const context = await browser.newContext({ locale: 'es-ES', viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    await context.addInitScript(() => {
        localStorage.setItem('pageforge.local-persistence-enabled', 'false');
        localStorage.setItem('pageforge.locale', 'es');
    });
    const page = await context.newPage();
    page.on('pageerror', error => failures.push(error.message));
    await page.goto(server.url);
    await page.waitForFunction(() => {
        const status = document.querySelector('[data-session-status]');
        return status && status.dataset.sessionStatus !== 'loading';
    }, undefined, { timeout: 60000 });
    await page.locator('input[type=file]').first().setInputFiles({ name: 'tools.pdf', mimeType: 'application/pdf', buffer: await makeFixture() });
    await page.waitForFunction(() => document.querySelectorAll('.document-card').length === 3 && !document.querySelector('[data-operation-status]'), undefined, { timeout: 60000 });

    const openEditor = async index => {
        await page.locator('.document-card').nth(index).hover();
        await page.getByRole('button', { name: 'Editar página', exact: true }).nth(index).click();
        await page.getByRole('dialog').first().waitFor();
    };

    // 1. Fill the form on page 1.
    await openEditor(0);
    const formTool = page.getByRole('button', { name: 'Rellenar formulario', exact: true });
    await formTool.waitFor({ timeout: 30000 });
    await formTool.click();
    await page.getByRole('textbox', { name: 'name', exact: true }).fill('Ana Pérez');
    await page.getByRole('checkbox', { name: 'consent', exact: true }).check();
    await screenshot(page, 'form');
    await page.getByRole('button', { name: 'Guardar', exact: true }).click();
    await page.getByRole('button', { name: 'Rellenar formulario', exact: true }).waitFor({ state: 'detached' });

    // 2. Redact the secret line on page 2.
    await openEditor(1);
    await page.getByRole('button', { name: 'Tachar', exact: true }).click();
    const canvas = page.locator('canvas[aria-label^="Lienzo de anotaciones"]');
    await canvas.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    const box = await canvas.boundingBox();
    assert(box, 'The annotation canvas must be visible.');
    // "TOPSECRET" sits at y = 420 pt of 842: about half-way down, near the left edge.
    await page.mouse.move(box.x + box.width * 0.04, box.y + box.height * 0.46);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.52, { steps: 5 });
    await page.mouse.up();
    await page.getByText('esta página se exportará como imagen').waitFor();
    await screenshot(page, 'redaction');
    await page.getByRole('button', { name: 'Guardar', exact: true }).click();
    await page.getByRole('button', { name: 'Tachar', exact: true }).waitFor({ state: 'detached' });

    // 3. Export with maximum image compression.
    await page.getByRole('button', { name: 'Exportar', exact: true }).click();
    await page.getByRole('radio', { name: /^Máxima/ }).check();
    await screenshot(page, 'export-dialog');
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Exportar todo', exact: true }).click();
    const exported = await readDownload(await pending);
    await page.getByText(/Imágenes reducidas de/).waitFor({ timeout: 30000 });
    await screenshot(page, 'workspace');

    const document = await PDFDocument.load(exported);
    assert.equal(document.getPageCount(), 3);
    const form = document.getForm();
    assert.equal(form.getTextField('applicant.name').getText(), 'Ana Pérez');
    assert.equal(form.getCheckBox('consent').isChecked(), true);

    const streams = await streamText(exported);
    assert(!streams.includes('TOPSECRET') && !streams.toUpperCase().includes(hex('TOPSECRET')), 'Redacted text must not remain in the file.');
    // The rest of page 2 survives as pixels; page 1 keeps its vector text.
    assert(streams.includes(hex('Application form')) || streams.includes('Application form'), 'Unredacted pages keep their text.');

    const imageWidths = document.context.enumerateIndirectObjects().flatMap(([, object]) => {
        if (!(object instanceof PDFRawStream) || object.dict.get(PDFName.of('Subtype'))?.toString() !== '/Image') return [];
        return [object.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber()];
    });
    // The redacted page raster and the photo, both at most 96 ppi over 11.7 in.
    assert(imageWidths.length >= 2, `Expected the photo and the redacted page image: ${imageWidths}`);
    assert(Math.max(...imageWidths) <= 1123, `Images must be downscaled: ${imageWidths}`);
    assert(exported.length < 1_500_000, `Compressed export should be small: ${exported.length} bytes`);

    assert.deepEqual(failures, []);
    console.log(JSON.stringify({ browserKind, bytes: exported.length, imageWidths }));
} finally {
    await browser.close();
    await server.stop();
}
