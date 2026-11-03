import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { PDFDocument, PDFName, PDFDict, PDFNumber } from 'pdf-lib';
import { chromium, firefox, webkit } from 'playwright';
import { startLocalTestServer } from './local-test-server.mjs';

// Imports generated DOCX/ODT fixtures and checks the exported pages: page count,
// the document's own page size, and twice-CSS raster resolution.
const engines = { chromium, firefox, webkit };
const browserKind = process.env.BROWSER_KIND ?? 'chromium';
assert(browserKind in engines, 'Unsupported browser engine.');
const server = await startLocalTestServer('preview');
const browser = await engines[browserKind].launch({ headless: true }).catch(async error => {
    await server.stop();
    throw error;
});

const paragraph = text => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const makeDocx = async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
    const longSection = Array.from({ length: 90 }, (_, index) => paragraph(`Fictitious line ${index + 1} of a long section that must flow onto further pages.`)).join('');
    zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraph('First page')}<w:p><w:r><w:br w:type="page"/></w:r></w:p>${longSection}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708"/></w:sectPr></w:body></w:document>`);
    return { name: 'fixture.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: await zip.generateAsync({ type: 'nodebuffer' }) };
};
const makeOdt = async () => {
    const zip = new JSZip();
    zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
    zip.file('META-INF/manifest.xml', '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/></manifest:manifest>');
    const ns = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"';
    // A5 portrait with 1.5 cm margins.
    zip.file('styles.xml', `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${ns}><office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="14.8cm" fo:page-height="21cm" fo:margin-top="1.5cm" fo:margin-bottom="1.5cm" fo:margin-left="1.5cm" fo:margin-right="1.5cm"/></style:page-layout></office:automatic-styles><office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"/></office:master-styles></office:document-styles>`);
    const rows = Array.from({ length: 4 }, (_, index) => `<table:table-row><table:table-cell><text:p>Row ${index + 1}</text:p></table:table-cell><table:table-cell><text:p>Value ${index + 1}</text:p></table:table-cell></table:table-row>`).join('');
    const lines = Array.from({ length: 60 }, (_, index) => `<text:p>Fictitious paragraph ${index + 1}<text:s text:c="3"/>with kept spaces.</text:p>`).join('');
    zip.file('content.xml', `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ns}><office:automatic-styles><style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style></office:automatic-styles><office:body><office:text><text:h text:outline-level="1">Fixture title</text:h><text:p>Normal and <text:span text:style-name="T1">bold</text:span> text.</text:p><text:list><text:list-item><text:p>First item</text:p></text:list-item></text:list><table:table>${rows}</table:table>${lines}</office:text></office:body></office:document-content>`);
    return { name: 'fixture.odt', mimeType: 'application/vnd.oasis.opendocument.text', buffer: await zip.generateAsync({ type: 'nodebuffer' }) };
};

/** Page sizes (pt) and the pixel width of each page's single image. */
const inspect = async bytes => {
    const document = await PDFDocument.load(bytes);
    return document.getPages().map(page => {
        const resources = page.node.Resources();
        const forms = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
        // Exported pages wrap the imported page; find the image inside.
        let imageWidth = 0;
        const visit = dict => {
            for (const [, ref] of dict?.entries() ?? []) {
                const object = document.context.lookup(ref);
                const subtype = object?.dict?.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText();
                if (subtype === 'Image') imageWidth = Math.max(imageWidth, object.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber());
                if (subtype === 'Form') visit(object.dict.lookupMaybe(PDFName.of('Resources'), PDFDict)?.lookupMaybe(PDFName.of('XObject'), PDFDict));
            }
        };
        visit(forms);
        const { width, height } = page.getSize();
        return { width, height, imageWidth };
    });
};

const failures = [];
const consoleErrors = [];
try {
    const context = await browser.newContext({ locale: 'es-ES', viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    await context.addInitScript(() => {
        localStorage.setItem('pageforge.local-persistence-enabled', 'false');
        localStorage.setItem('pageforge.locale', 'es');
    });
    const page = await context.newPage();
    page.on('pageerror', error => failures.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.goto(server.url);
    // Imports are accepted once the session has finished loading.
    await page.waitForFunction(() => {
        const status = document.querySelector('[data-session-status]');
        return status && status.dataset.sessionStatus !== 'loading';
    }, undefined, { timeout: 60000 });

    const results = {};
    for (const fixture of [await makeDocx(), await makeOdt()]) {
        await page.locator('input[type=file]').first().setInputFiles(fixture);
        try {
            await page.waitForFunction(() => document.querySelectorAll('.document-card').length > 0 && !document.querySelector('[data-operation-status]'), undefined, { timeout: 60000 });
        } catch {
            throw new Error(`Office import failed for ${fixture.name}: ${JSON.stringify({ failures, consoleErrors, alerts: await page.getByRole('alert').allTextContents() })}`);
        }
        await page.getByRole('button', { name: 'Exportar', exact: true }).click();
        const pending = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Exportar todo', exact: true }).click();
        const download = await pending;
        const chunks = [];
        for await (const chunk of await download.createReadStream()) chunks.push(chunk);
        const exported = Buffer.concat(chunks);
        results[fixture.name] = { filename: download.suggestedFilename(), pages: await inspect(exported) };
        if (process.env.OFFICE_SCREENSHOT_DIR) {
            // Local review aid: keep the workspace screenshot and the exported PDF.
            await mkdir(process.env.OFFICE_SCREENSHOT_DIR, { recursive: true });
            await page.screenshot({ path: `${process.env.OFFICE_SCREENSHOT_DIR}/${browserKind}-${fixture.name}.png` });
            await writeFile(`${process.env.OFFICE_SCREENSHOT_DIR}/${browserKind}-${fixture.name}.pdf`, exported);
        }
        await page.getByRole('button', { name: 'Limpiar', exact: true }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Limpiar', exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll('.document-card').length === 0);
    }

    const docx = results['fixture.docx'];
    assert(docx.pages.length >= 3, `DOCX should keep its page break and paginate overflow: ${docx.pages.length} pages`);
    for (const exported of docx.pages) {
        assert(Math.abs(exported.width - 595.3) < 2 && Math.abs(exported.height - 841.9) < 2, `DOCX page should be A4: ${exported.width}x${exported.height}`);
        assert(exported.imageWidth >= 1500, `DOCX page should be rendered at 2x: ${exported.imageWidth}px`);
    }
    assert.equal(docx.filename, 'fixture_editado.pdf');

    const odt = results['fixture.odt'];
    assert(odt.pages.length >= 2, `ODT should paginate: ${odt.pages.length} pages`);
    for (const exported of odt.pages) {
        assert(Math.abs(exported.width - 419.5) < 2 && Math.abs(exported.height - 595.3) < 2, `ODT page should be A5: ${exported.width}x${exported.height}`);
        assert(exported.imageWidth >= 1050, `ODT page should be rendered at 2x: ${exported.imageWidth}px`);
    }
    assert.deepEqual(failures, []);
    console.log(JSON.stringify({ browserKind, docxPages: docx.pages.length, odtPages: odt.pages.length, docxImageWidth: docx.pages[0].imageWidth, odtImageWidth: odt.pages[0].imageWidth }));
} finally {
    await browser.close();
    await server.stop();
}
