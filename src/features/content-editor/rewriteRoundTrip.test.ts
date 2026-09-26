import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { applyContentEditsToPdfPage } from './applyContentEdits';
import type { TextContentBlock } from './types';

const editFor = (text: string, x: number, y: number, replacement: string): TextContentBlock => ({
    id: `${x}-${y}`, pageIndex: 0, type: 'text', x, y, origX: x, origY: y,
    width: 100, height: 20, pdfX: x, pdfY: y, origPdfX: x, origPdfY: y,
    origWidth: 100, pdfRotation: 0, screenRotation: 0, backgroundColor: [0.8, 0.9, 1],
    isDirty: true, text: replacement, originalText: text, pdfFontSize: 20,
    pdfTextScaleX: 1, screenFontSize: 20, screenTextScaleX: 1, screenFontAscent: 16,
    fontInfo: { bold: false, italic: false, family: 'sans', cssFamily: 'Arial', rawName: 'Helvetica' },
    pdfColor: [0, 0, 0], textEffects: { renderingMode: 0, strokeColor: [0, 0, 0], strokeWidth: 1, screenStrokeWidth: 1 },
});

const extract = async (document: PDFDocument) => {
    const task = getDocument({ data: await document.save(), useSystemFonts: true, useWasm: false });
    try {
        const text = await (await (await task.promise).getPage(1)).getTextContent();
        return text.items.flatMap(item => 'str' in item && item.str.trim() ? [{ text: item.str, x: item.transform[4], y: item.transform[5] }] : []);
    } finally { await task.destroy(); }
};

const renderedInkPixels = async (document: PDFDocument, top: number) => {
    const task = getDocument({ data: await document.save(), useSystemFonts: true, useWasm: false });
    try {
        const page = await (await task.promise).getPage(1);
        const canvas = createCanvas(420, 550);
        const context = canvas.getContext('2d');
        await page.render({
            canvas: canvas as unknown as HTMLCanvasElement,
            canvasContext: context as unknown as CanvasRenderingContext2D,
            viewport: page.getViewport({ scale: 1 }),
        }).promise;
        const pixels = context.getImageData(50, top, 250, 35).data;
        let ink = 0;
        for (let index = 0; index < pixels.length; index += 4) {
            if (pixels[index] < 180 && pixels[index + 1] < 180 && pixels[index + 2] < 180) ink += 1;
        }
        return ink;
    } finally { await task.destroy(); }
};

describe('content rewriting export round trips', () => {
    it('embeds Unicode fallback glyphs with searchable text and stable following content', async () => {
        const document = await PDFDocument.create();
        const font = await document.embedFont(StandardFonts.Helvetica);
        const page = document.addPage([420, 550]);
        page.drawText('Original', { x: 60, y: 450, size: 20, font });
        page.drawText('Neighbor', { x: 60, y: 390, size: 20, font });
        const western = readFileSync(new URL('../../../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf', import.meta.url));
        const cjk = readFileSync(new URL('../../../public/fonts/NotoSansCJKsc-Regular.otf', import.meta.url));
        await applyContentEditsToPdfPage(document, page, [
            editFor('Original', 60, 450, 'Привет 世界'),
        ], { western, cjk });
        expect(await extract(document)).toEqual([
            { text: 'Привет 世界', x: 60, y: 450 },
            { text: 'Neighbor', x: 60, y: 390 },
        ]);
        expect(await renderedInkPixels(document, 85)).toBeGreaterThan(50);
    });

    it('can install two Unicode fallback fonts on one page', async () => {
        const document = await PDFDocument.create();
        const font = await document.embedFont(StandardFonts.Helvetica);
        const page = document.addPage([420, 550]);
        page.drawText('First', { x: 60, y: 450, size: 20, font });
        page.drawText('Second', { x: 60, y: 390, size: 20, font });
        const western = readFileSync(new URL('../../../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf', import.meta.url));
        const cjk = readFileSync(new URL('../../../public/fonts/NotoSansCJKsc-Regular.otf', import.meta.url));
        await applyContentEditsToPdfPage(document, page, [
            editFor('First', 60, 450, 'Привет'),
            editFor('Second', 60, 390, '世界'),
        ], { western, cjk });
        expect(await extract(document)).toEqual([
            { text: 'Привет', x: 60, y: 450 },
            { text: '世界', x: 60, y: 390 },
        ]);
        expect(await renderedInkPixels(document, 145)).toBeGreaterThan(15);
    });

    it('can edit Unicode fallback text again after saving and reopening', async () => {
        const document = await PDFDocument.create();
        const font = await document.embedFont(StandardFonts.Helvetica);
        const page = document.addPage([420, 550]);
        page.drawText('Original', { x: 60, y: 450, size: 20, font });
        const western = readFileSync(new URL('../../../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf', import.meta.url));
        const cjk = readFileSync(new URL('../../../public/fonts/NotoSansCJKsc-Regular.otf', import.meta.url));
        await applyContentEditsToPdfPage(document, page, [
            editFor('Original', 60, 450, 'Привет 世界'),
        ], { western, cjk });
        const reopened = await PDFDocument.load(await document.save());
        await applyContentEditsToPdfPage(reopened, reopened.getPage(0), [
            editFor('Привет 世界', 60, 450, 'До свидания'),
        ], { western, cjk });
        expect((await extract(reopened)).map(item => item.text)).toEqual(['До свидания']);
    });

    it('rejects an unavailable Unicode glyph without changing page contents', async () => {
        const document = await PDFDocument.create();
        const font = await document.embedFont(StandardFonts.Helvetica);
        const page = document.addPage([420, 550]);
        page.drawText('Original', { x: 60, y: 450, size: 20, font });
        page.drawText('Neighbor', { x: 60, y: 390, size: 20, font });
        const before = page.node.get(PDFName.Contents);
        const western = readFileSync(new URL('../../../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf', import.meta.url));
        const cjk = readFileSync(new URL('../../../public/fonts/NotoSansCJKsc-Regular.otf', import.meta.url));
        await expect(applyContentEditsToPdfPage(document, page, [
            editFor('Neighbor', 60, 390, 'Changed'),
            editFor('Original', 60, 450, 'مرحبا'),
        ], { western, cjk })).rejects.toThrow('No bundled Unicode font');
        expect(page.node.get(PDFName.Contents)).toBe(before);
        expect((await extract(document)).map(item => item.text)).toEqual(['Original', 'Neighbor']);
    });

    it('can edit a page embedded by export, then export and edit again', async () => {
        const original = await PDFDocument.create();
        const font = await original.embedFont(StandardFonts.Helvetica);
        const page = original.addPage([420, 550]);
        page.drawRectangle({ x: 0, y: 0, width: 420, height: 550, color: rgb(0.8, 0.9, 1) });
        page.drawText('Original', { x: 60, y: 450, size: 20, font });
        page.drawText('Neighbor', { x: 60, y: 390, size: 20, font });
        await original.flush();
        let current = original;
        for (const [before, after] of [['Original', 'First'], ['First', 'Second']]) {
            const exported = await PDFDocument.create();
            const embedded = await exported.embedPage(current.getPage(0));
            exported.addPage([420, 550]).drawPage(embedded);
            current = await PDFDocument.load(await exported.save());
            await applyContentEditsToPdfPage(current, current.getPage(0), [editFor(before, 60, 450, after)]);
            const items = await extract(current);
            expect(items.map(item => item.text)).toEqual([after, 'Neighbor']);
            expect(items.find(item => item.text === 'Neighbor')).toMatchObject({ x: 60, y: 390 });
        }
        expect((await extract(original)).map(item => item.text)).toEqual(['Original', 'Neighbor']);
    });

    it('applies different edits to two occurrences of one exported form', async () => {
        const source = await PDFDocument.create();
        const font = await source.embedFont(StandardFonts.Helvetica);
        source.addPage([120, 120]).drawText('Repeated', { x: 10, y: 80, size: 20, font });
        await source.flush();
        const document = await PDFDocument.create();
        const embedded = await document.embedPage(source.getPage(0));
        const page = document.addPage([420, 550]);
        page.drawPage(embedded, { x: 0, y: 0 });
        page.drawPage(embedded, { x: 200, y: 200 });
        await applyContentEditsToPdfPage(document, page, [
            editFor('Repeated', 10, 80, 'One'),
            editFor('Repeated', 210, 280, 'Two'),
        ]);
        expect((await extract(document)).map(item => item.text)).toEqual(['One', 'Two']);
        expect((await extract(source)).map(item => item.text)).toEqual(['Repeated']);
    });

    it('does not mutate a shared form or page when another edit is rejected', async () => {
        const source = await PDFDocument.create();
        const font = await source.embedFont(StandardFonts.Helvetica);
        source.addPage([120, 120]).drawText('Repeated', { x: 10, y: 80, size: 20, font });
        await source.flush();
        const document = await PDFDocument.create();
        const embedded = await document.embedPage(source.getPage(0));
        const page = document.addPage([420, 550]);
        page.drawPage(embedded);
        await document.flush();
        const initialContents = page.node.get(PDFName.Contents);
        const initialResources = page.node.get(PDFName.Resources);
        await expect(applyContentEditsToPdfPage(document, page, [
            editFor('Repeated', 10, 80, 'Valid'),
            editFor('Missing', 300, 400, 'Invalid'),
        ])).rejects.toThrow();
        expect(page.node.get(PDFName.Contents)).toBe(initialContents);
        expect(page.node.get(PDFName.Resources)).toBe(initialResources);
        expect((await extract(document)).map(item => item.text)).toEqual(['Repeated']);
    });

    it('accepts trailing-decimal PDF numbers and does not mistake text for an inline image', async () => {
        const document = await PDFDocument.create();
        const font = await document.embedFont(StandardFonts.Helvetica);
        const page = document.addPage([420, 550]);
        page.node.set(PDFName.Resources, document.context.obj({ Font: { F0: font.ref } }));
        const source = 'q 1. 0 0 1. 0 0 cm BT /F0 20 Tf 1 0 0 1 60 450 Tm (BI <<) Tj ET Q';
        page.node.set(PDFName.Contents, document.context.register(document.context.flateStream(source)));
        await applyContentEditsToPdfPage(document, page, [editFor('BI <<', 60, 450, 'Valid')]);
        expect((await extract(document)).map(item => item.text)).toEqual(['Valid']);
    });

    it('rejects nonfinite coordinates without changing the page', async () => {
        const document = await PDFDocument.create();
        const font = await document.embedFont(StandardFonts.Helvetica);
        const page = document.addPage([420, 550]);
        page.drawText('Original', { x: 60, y: 450, size: 20, font });
        const before = page.node.get(PDFName.Contents);
        await expect(applyContentEditsToPdfPage(document, page, [{ ...editFor('Original', 60, 450, 'Changed'), pdfX: Number.NaN }])).rejects.toThrow('finite');
        expect(page.node.get(PDFName.Contents)).toBe(before);
    });

    it('rejects property dictionaries without corrupting their delimiters', async () => {
        const document = await PDFDocument.create();
        const page = document.addPage([420, 550]);
        const source = '/Artifact << /Type /Layout >> BDC BT /F0 20 Tf 1 0 0 1 60 450 Tm (Original) Tj ET EMC';
        const ref = document.context.register(document.context.flateStream(source));
        page.node.set(PDFName.Contents, ref);
        await expect(applyContentEditsToPdfPage(document, page, [editFor('Original', 60, 450, 'Changed')])).rejects.toThrow('marked-content');
        expect(page.node.get(PDFName.Contents)).toBe(ref);
    });

    it('resolves escaped Form names, inherited resources, and composed matrices', async () => {
        const document = await PDFDocument.create();
        const font = await document.embedFont(StandardFonts.Helvetica);
        const page = document.addPage([420, 550]);
        const form = document.context.register(document.context.flateStream('BT /F0 20 Tf 1 0 0 1 10 80 Tm (Original) Tj ET', {
            Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 120, 120], Matrix: [2, 0, 0, 2, 5, 7],
        }));
        page.node.set(PDFName.Resources, document.context.obj({ Font: { F0: font.ref }, XObject: { Fm1: form } }));
        page.node.set(PDFName.Contents, document.context.register(document.context.flateStream('q 0 1 -1 0 300 0 cm /Fm#31 Do Q')));
        await applyContentEditsToPdfPage(document, page, [editFor('Original', 133, 25, 'Changed')]);
        expect(await extract(document)).toEqual([{ text: 'Changed', x: 133, y: 25 }]);
    });
});
