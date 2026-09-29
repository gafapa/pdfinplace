import { describe, expect, it } from 'vitest';
import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFName,
    PDFRawStream,
    PDFStream,
    StandardFonts,
    decodePDFRawStream,
    rgb,
    type PDFPage,
} from 'pdf-lib';
import { applyContentEditsToPdfPage, ContentRewriteError } from './applyContentEdits';
import { rewriteContentSource } from './rewriteContentStreams';
import type { ContentEdit, TextContentBlock } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder('latin1');

const toHex = (text: string) => [...encoder.encode(text)]
    .map((byte) => byte.toString(16).padStart(2, '0').toUpperCase())
    .join('');

const makeTextEdit = (overrides: Partial<TextContentBlock> = {}): TextContentBlock => ({
    id: '0-text-0',
    pageIndex: 0,
    type: 'text',
    x: 40,
    y: 144,
    origX: 40,
    origY: 144,
    width: 48,
    height: 16,
    pdfX: 40,
    pdfY: 160,
    origPdfX: 40,
    origPdfY: 160,
    origWidth: 48,
    pdfRotation: 0,
    screenRotation: 0,
    backgroundColor: [1, 1, 1],
    isDirty: true,
    text: 'Updated',
    originalText: 'Target',
    pdfFontSize: 16,
    pdfTextScaleX: 1,
    screenFontSize: 16,
    screenTextScaleX: 1,
    screenFontAscent: 12,
    fontInfo: {
        bold: false,
        italic: false,
        family: 'sans',
        cssFamily: 'Helvetica, sans-serif',
        rawName: 'Helvetica',
    },
    pdfColor: [0, 0, 0],
    textEffects: {
        renderingMode: 0,
        strokeColor: [0, 0, 0],
        strokeWidth: 1,
        screenStrokeWidth: 1,
    },
    ...overrides,
});

const makeImageEdit = (
    overrides: Partial<Extract<ContentEdit, { type: 'image' }>> = {},
): Extract<ContentEdit, { type: 'image' }> => ({
    id: '0-image-0',
    pageIndex: 0,
    type: 'image',
    x: 20,
    y: 30,
    origX: 20,
    origY: 30,
    width: 100,
    height: 50,
    pdfX: 20,
    pdfY: 30,
    origPdfX: 20,
    origPdfY: 30,
    origWidth: 100,
    origHeight: 50,
    pdfWidth: 100,
    pdfHeight: 50,
    pdfRotation: 0,
    screenRotation: 0,
    backgroundColor: [1, 1, 1],
    imageDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+KiSlJwAAAABJRU5ErkJggg==',
    isDirty: true,
    ...overrides,
});

const decodedPageStreams = (page: PDFPage) => {
    const contents = page.node.Contents();
    if (!contents) return [];
    const entries = contents instanceof PDFArray ? contents.asArray() : [contents];

    return entries.map((entry) => {
        const stream = entry instanceof PDFStream
            ? entry
            : page.doc.context.lookup(entry, PDFStream);
        if (stream instanceof PDFRawStream) return decoder.decode(decodePDFRawStream(stream).decode());
        const unencoded = (stream as PDFStream & { getUnencodedContents?: () => Uint8Array }).getUnencodedContents;
        if (!unencoded) throw new Error('Expected a readable page content stream.');
        return decoder.decode(unencoded.call(stream));
    });
};

const savedPageStreams = async (pdfDocument: PDFDocument) => {
    const reloaded = await PDFDocument.load(await pdfDocument.save());
    return decodedPageStreams(reloaded.getPage(0));
};

const savedPageStreamBytes = async (pdfDocument: PDFDocument) => {
    const reloaded = await PDFDocument.load(await pdfDocument.save());
    const contents = reloaded.getPage(0).node.Contents();
    if (!contents) return [];
    const entries = contents instanceof PDFArray ? contents.asArray() : [contents];
    return entries.flatMap((entry) => {
        const stream = entry instanceof PDFRawStream
            ? entry
            : reloaded.context.lookup(entry, PDFStream);
        if (!(stream instanceof PDFRawStream)) throw new Error('Expected a saved raw stream.');
        return [...decodePDFRawStream(stream).decode()];
    });
};

const appendStream = (pdfDocument: PDFDocument, page: PDFPage, source: string | Uint8Array) => {
    const bytes = typeof source === 'string' ? encoder.encode(source) : source;
    const streamRef = pdfDocument.context.register(pdfDocument.context.flateStream(bytes));
    page.node.addContentStream(streamRef);
};

const extractTextItems = async (pdfDocument: PDFDocument) => {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = getDocument({
        data: (await pdfDocument.save()).slice(),
        useWorkerFetch: false,
    });
    const pdf = await loadingTask.promise;
    const content = await (await pdf.getPage(1)).getTextContent();
    await loadingTask.destroy();
    return content.items.filter((item) => 'str' in item).map((item) => ({
        text: item.str,
        transform: item.transform,
    }));
};

describe('content stream rewriting', () => {
    it('returns valid stream patches for a Form-scoped caller', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([300, 300]);
        const font = await pdfDocument.embedFont(StandardFonts.Helvetica);
        await pdfDocument.flush();
        const fontKey = page.node.newFontDictionary(font.name, font.ref).toString();
        const result = rewriteContentSource({
            pdfPage: page,
            resources: page.node.Resources(),
            source: `BT ${fontKey} 16 Tf 1 0 0 1 40 160 Tm (Target) Tj ET`,
            edits: [makeTextEdit()],
        });

        expect(decoder.decode(result.source)).toContain('(Updated)');
    });

    it('rewrites an editor text item split across consecutive show operators', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([300, 300]);
        const font = await pdfDocument.embedFont(StandardFonts.Helvetica);
        const fontKey = page.node.newFontDictionary(font.name, font.ref).toString();
        appendStream(pdfDocument, page, [
            'BT', `${fontKey} 16 Tf`, '1 0 0 1 40 160 Tm', '(Tar) Tj', '(get) Tj', 'ET',
            'BT', `${fontKey} 16 Tf`, '1 0 0 1 100 100 Tm', '(Neighbor) Tj', 'ET',
        ].join('\n'));
        const beforeNeighbor = (await extractTextItems(pdfDocument)).find(item => item.text === 'Neighbor');
        await applyContentEditsToPdfPage(pdfDocument, page, [makeTextEdit()]);

        const after = await extractTextItems(pdfDocument);
        expect(after.map(item => item.text).join(' ')).toContain('Updated');
        expect(after.map(item => item.text).join(' ')).not.toContain('Target');
        expect(after.find(item => item.text === 'Neighbor')?.transform).toEqual(beforeNeighbor?.transform);
    });

    it('anchors a whitespace-prefixed TJ run at the visible glyph baseline', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([300, 300]);
        const font = await pdfDocument.embedFont(StandardFonts.Helvetica);
        const fontKey = page.node.newFontDictionary(font.name, font.ref).toString();
        appendStream(pdfDocument, page, [
            'BT', `${fontKey} 16 Tf`, '1 Tc', '2 Tw', '1 0 0 1 40 160 Tm', '[ 100 ( Target) ] TJ', 'ET',
        ].join('\n'));
        const visibleX = 46.848;

        await applyContentEditsToPdfPage(pdfDocument, page, [makeTextEdit({ origPdfX: visibleX, pdfX: visibleX })]);

        const updated = (await extractTextItems(pdfDocument)).find(item => item.text === 'Updated');
        expect(updated?.transform[4]).toBeCloseTo(visibleX, 2);
    });

    it('does not replay the middle show when replacing three grouped runs', async () => {
        const document = await PDFDocument.create();
        const page = document.addPage([300, 300]);
        const font = await document.embedFont(StandardFonts.Helvetica);
        const key = page.node.newFontDictionary(font.name, font.ref).toString();
        appendStream(document, page, `BT ${key} 16 Tf 1 0 0 1 40 160 Tm (Ta) Tj 2 Tr (rg) Tj 0 Tr (et) Tj ET`);
        await applyContentEditsToPdfPage(document, page, [makeTextEdit()]);
        expect((await extractTextItems(document)).map(item => item.text).join('')).toBe('Updated');
    });

    it('retains the original style and show instructions when moving a grouped run', async () => {
        const document = await PDFDocument.create();
        const page = document.addPage([300, 300]);
        const font = await document.embedFont(StandardFonts.Helvetica);
        const key = page.node.newFontDictionary(font.name, font.ref).toString();
        appendStream(document, page, `BT ${key} 16 Tf 1 0 0 1 40 160 Tm 2 Tr (Tar) Tj 0 Tr 1 w (get) Tj ET`);
        await applyContentEditsToPdfPage(document, page, [makeTextEdit({ text: 'Target', pdfX: 43 })]);
        expect((await savedPageStreams(document)).join('\n')).toContain('(Tar) Tj 0 Tr 1 w (get) Tj');
        expect((await extractTextItems(document))[0].transform[4]).toBeCloseTo(43, 4);
    });

    it('matches a pdf.js text run split by stroke-style operators', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([300, 300]);
        const font = await pdfDocument.embedFont(StandardFonts.Helvetica);
        const fontKey = page.node.newFontDictionary(font.name, font.ref).toString();
        appendStream(pdfDocument, page, [
            'BT', `${fontKey} 16 Tf`, '1 0 0 1 40 160 Tm', '2 Tr', '0.2 w', '(Tar) Tj', '0 Tr', '1 w', '(get) Tj', 'ET',
        ].join('\n'));

        await applyContentEditsToPdfPage(pdfDocument, page, [makeTextEdit()]);

        const source = (await savedPageStreams(pdfDocument)).join('\n');
        expect(source).toContain('0 Tr 1 w');
        expect((await extractTextItems(pdfDocument)).map(item => item.text).join(' ')).toContain('Updated');
    });

    it('moves a grouped text run while preserving a later neighbor position', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([300, 300]);
        const font = await pdfDocument.embedFont(StandardFonts.Helvetica);
        const fontKey = page.node.newFontDictionary(font.name, font.ref).toString();
        appendStream(pdfDocument, page, [
            'BT', `${fontKey} 16 Tf`, '1 0 0 1 40 160 Tm', '(Tar) Tj', '(get) Tj', '20 0 Td', '(Neighbor) Tj', 'ET',
        ].join('\n'));
        const beforeNeighbor = (await extractTextItems(pdfDocument)).find(item => item.text === 'Neighbor');

        await applyContentEditsToPdfPage(pdfDocument, page, [makeTextEdit({ text: 'Target', pdfX: 43 })]);

        const after = await extractTextItems(pdfDocument);
        expect(after.find(item => item.text === 'Target')?.transform[4]).toBeCloseTo(43, 4);
        expect(after.find(item => item.text === 'Neighbor')?.transform).toEqual(beforeNeighbor?.transform);
    });

    it('removes the original text operation, writes the replacement, and retains neighboring content', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([300, 300]);
        const font = await pdfDocument.embedFont(StandardFonts.Helvetica);
        page.drawRectangle({ x: 0, y: 0, width: 300, height: 300, color: rgb(0.95, 0.9, 0.8) });
        page.drawText('Target', { x: 40, y: 160, size: 16, font });
        page.drawText('Target', { x: 140, y: 160, size: 16, font });

        await applyContentEditsToPdfPage(pdfDocument, page, [makeTextEdit()]);

        const source = (await savedPageStreams(pdfDocument)).join('\n');
        expect(source.match(new RegExp(toHex('Target'), 'g'))).toHaveLength(1);
        expect(source).toContain('(Updated)');
        expect(source).toContain(toHex('Target'));
        expect(source).toMatch(/1 0 0 1 140 160 Tm/);
        expect(source).toContain('0.95 0.9 0.8 rg');
    });

    it('rewrites only the matching operation when the page uses multiple content streams', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([300, 300]);
        const font = await pdfDocument.embedFont(StandardFonts.Helvetica);
        page.drawText('Target', { x: 40, y: 160, size: 16, font });
        appendStream(pdfDocument, page, '0.2 0.4 0.6 rg\n10 10 30 30 re\nf\n');

        await applyContentEditsToPdfPage(pdfDocument, page, [makeTextEdit()]);

        const streams = await savedPageStreams(pdfDocument);
        expect(streams.length).toBeGreaterThan(0);
        expect(streams.join('\n')).not.toContain(toHex('Target'));
        expect(streams.join('\n')).toContain('(Updated)');
        expect(streams.join('\n')).toContain('0.2 0.4 0.6 rg');
    });

    it('keeps the following text advance when a replacement has a different length', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([300, 300]);
        const font = await pdfDocument.embedFont(StandardFonts.Helvetica);
        const fontKey = page.node.newFontDictionary(font.name, font.ref).toString();
        appendStream(pdfDocument, page, [
            'BT',
            `${fontKey} 16 Tf`,
            '1 0 0 1 40 160 Tm',
            `<${toHex('Target')}> Tj`,
            '20 0 Td',
            `<${toHex('Neighbor')}> Tj`,
            'ET',
        ].join('\n'));
        const beforeNeighbor = (await extractTextItems(pdfDocument)).find((item) => item.text === 'Neighbor');

        await applyContentEditsToPdfPage(pdfDocument, page, [makeTextEdit({ text: 'A much longer replacement' })]);

        const items = await extractTextItems(pdfDocument);
        const afterNeighbor = items.find((item) => item.text === 'Neighbor');
        expect(items.map((item) => item.text).join(' ')).toContain('A much longer replacement');
        expect(afterNeighbor?.transform).toEqual(beforeNeighbor?.transform);
    });

    it('keeps the following text position when a TJ operand has numeric spacing', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([300, 300]);
        const font = await pdfDocument.embedFont(StandardFonts.Helvetica);
        const fontKey = page.node.newFontDictionary(font.name, font.ref).toString();
        appendStream(pdfDocument, page, [
            'BT', `${fontKey} 16 Tf`, '1 0 0 1 40 160 Tm',
            `[<${toHex('Target')}> -120] TJ`, '20 0 Td',
            `<${toHex('Neighbor')}> Tj`, 'ET',
        ].join('\n'));
        const beforeNeighbor = (await extractTextItems(pdfDocument)).find((item) => item.text === 'Neighbor');

        await applyContentEditsToPdfPage(pdfDocument, page, [makeTextEdit()]);

        const afterNeighbor = (await extractTextItems(pdfDocument)).find((item) => item.text === 'Neighbor');
        expect(afterNeighbor?.transform).toEqual(beforeNeighbor?.transform);
    });

    it('preserves an explicit line movement after a quote text-show operation', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([300, 300]);
        const font = await pdfDocument.embedFont(StandardFonts.Helvetica);
        const fontKey = page.node.newFontDictionary(font.name, font.ref).toString();
        appendStream(pdfDocument, page, [
            'BT', `${fontKey} 16 Tf`, '24 TL', '1 0 0 1 40 160 Tm',
            `<${toHex('Target')}> Tj`, `(Next line) '`, 'T*', '(After line move) Tj', 'ET',
        ].join('\n'));

        await applyContentEditsToPdfPage(pdfDocument, page, [makeTextEdit()]);

        const source = (await savedPageStreams(pdfDocument)).join('\n');
        expect(source).toContain("(Next line) '");
        expect(source).toContain('T*');
        expect(source).toContain('(After line move) Tj');
    });

    it('keeps Td, T*, and quote text on their original lines after moving text', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([300, 300]);
        const font = await pdfDocument.embedFont(StandardFonts.Helvetica);
        const fontKey = page.node.newFontDictionary(font.name, font.ref).toString();
        appendStream(pdfDocument, page, [
            'BT', `${fontKey} 16 Tf`, '24 TL', '1 0 0 1 40 160 Tm',
            `<${toHex('Target')}> Tj`, '20 0 Td', '(After Td) Tj',
            'T*', '(After star) Tj', "(After quote) '", 'ET',
        ].join('\n'));
        const before = await extractTextItems(pdfDocument);

        await applyContentEditsToPdfPage(pdfDocument, page, [makeTextEdit({ pdfX: 41 })]);

        const after = await extractTextItems(pdfDocument);
        for (const text of ['After Td', 'After star', 'After quote']) {
            expect(after.find((item) => item.text === text)?.transform)
                .toEqual(before.find((item) => item.text === text)?.transform);
        }
    });

    it('edits a quote text-show operand at its post-leading baseline', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([300, 300]);
        const font = await pdfDocument.embedFont(StandardFonts.Helvetica);
        const fontKey = page.node.newFontDictionary(font.name, font.ref).toString();
        appendStream(pdfDocument, page, [
            'BT', `${fontKey} 16 Tf`, '24 TL', '1 0 0 1 40 160 Tm', "(Quoted) '", 'ET',
        ].join('\n'));

        await applyContentEditsToPdfPage(pdfDocument, page, [makeTextEdit({
            originalText: 'Quoted',
            text: 'Edited quote',
            origPdfY: 136,
            pdfY: 136,
        })]);

        const text = (await extractTextItems(pdfDocument)).map((item) => item.text).join(' ');
        expect(text).toContain('Edited quote');
        expect(text).not.toContain('Quoted');
    });

    it('rewrites text under a nonidentity graphics transform without changing a separate image', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([300, 300]);
        const font = await pdfDocument.embedFont(StandardFonts.Helvetica);
        const fontKey = page.node.newFontDictionary(font.name, font.ref).toString();
        const image = await pdfDocument.embedPng(makeImageEdit().imageDataUrl);
        page.drawImage(image, { x: 150, y: 30, width: 100, height: 50 });
        await image.embed();
        appendStream(pdfDocument, page, [
            'q', '2 0 0 2 10 20 cm', 'BT', `${fontKey} 16 Tf`,
            '1 0 0 1 15 70 Tm', `<${toHex('Target')}> Tj`, 'ET', 'Q',
        ].join('\n'));

        await applyContentEditsToPdfPage(pdfDocument, page, [makeTextEdit()]);

        const source = (await savedPageStreams(pdfDocument)).join('\n');
        expect(source).toContain('(Updated)');
        expect(source.match(/\sDo\b/g)).toHaveLength(1);
        expect(source).toMatch(/\/Image-[\w-]+ Do/);
    });

    it('moves text by one PDF unit instead of treating it as unchanged', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([300, 300]);
        const font = await pdfDocument.embedFont(StandardFonts.Helvetica);
        page.drawText('Target', { x: 40, y: 160, size: 16, font });

        await applyContentEditsToPdfPage(pdfDocument, page, [makeTextEdit({ pdfX: 41 })]);

        expect((await savedPageStreams(pdfDocument)).join('\n')).toMatch(/1 0 0 1 41 160 Tm/);
    });

    it('uses raw standard-font glyph widths for AV without adding implicit kerning', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([300, 300]);
        const font = await pdfDocument.embedFont(StandardFonts.Helvetica);
        page.drawText('AV', { x: 40, y: 160, size: 16, font });

        await applyContentEditsToPdfPage(pdfDocument, page, [makeTextEdit({
            originalText: 'AV',
            text: 'A',
            origWidth: 21.34,
        })]);

        expect((await savedPageStreams(pdfDocument)).join('\n')).toMatch(/\[ \(A\) -667 \] TJ/);
    });

    it('does not apply Tw to a two-byte CID whose low byte is 32', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([300, 300]);
        const context = pdfDocument.context;
        const toUnicode = context.register(context.flateStream([
            '2 beginbfchar', '<0020> <0020>', '<0001> <0041>', 'endbfchar',
        ].join('\n')));
        const descendant = context.register(context.obj({ DW: 600, W: [1, [600], 32, [600]] }) as PDFDict);
        const compositeFont = context.register(context.obj({
            Type: 'Font',
            Subtype: 'Type0',
            Encoding: 'Identity-H',
            DescendantFonts: [descendant],
            ToUnicode: toUnicode,
        }) as PDFDict);
        page.node.setFontDictionary(PDFName.of('Fcid'), compositeFont);
        appendStream(pdfDocument, page, [
            'BT', '/Fcid 16 Tf', '100 Tw', '1 0 0 1 40 160 Tm',
            '<00200001> Tj', '20 0 Td', '(Neighbor) Tj', 'ET',
        ].join('\n'));
        const beforeNeighbor = (await extractTextItems(pdfDocument)).find((item) => item.text === 'Neighbor');

        await applyContentEditsToPdfPage(pdfDocument, page, [makeTextEdit({
            originalText: ' A',
            text: 'A',
        })]);

        const afterNeighbor = (await extractTextItems(pdfDocument)).find((item) => item.text === 'Neighbor');
        expect(afterNeighbor?.transform).toEqual(beforeNeighbor?.transform);
    });

    it('uses a scoped Helvetica fallback when an Identity-H subset lacks a replacement glyph', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([300, 300]);
        const context = pdfDocument.context;
        const toUnicode = context.register(context.flateStream([
            '6 beginbfchar', '<0001> <0054>', '<0002> <0061>', '<0003> <0072>',
            '<0004> <0067>', '<0005> <0065>', '<0006> <0074>', 'endbfchar',
        ].join('\n')));
        const descendant = context.register(context.obj({ DW: 600, W: [1, [600, 600, 600, 600, 600, 600]] }) as PDFDict);
        const compositeFont = context.register(context.obj({
            Type: 'Font', Subtype: 'Type0', Encoding: 'Identity-H', DescendantFonts: [descendant], ToUnicode: toUnicode,
        }) as PDFDict);
        page.node.setFontDictionary(PDFName.of('Fsubset'), compositeFont);
        appendStream(pdfDocument, page, [
            'BT', '/Fsubset 16 Tf', '1 0 0 1 40 160 Tm', '<000100020003000400050006> Tj', '(Neighbor) Tj', 'ET',
        ].join('\n'));
        const beforeNeighbor = (await extractTextItems(pdfDocument)).find((item) => item.text === 'Neighbor');

        await applyContentEditsToPdfPage(pdfDocument, page, [makeTextEdit({ text: 'p' })]);

        const after = await extractTextItems(pdfDocument);
        expect(after.map(item => item.text).join(' ')).toContain('p');
        expect(after.map(item => item.text).join(' ')).not.toContain('Target');
        expect(after.find((item) => item.text === 'Neighbor')?.transform).toEqual(beforeNeighbor?.transform);
        expect((await savedPageStreams(pdfDocument)).join('\n')).toMatch(/\/PDFingFallback\s+16\s+Tf/);
    });

    it('preserves untouched bytes in the 0x80–0x9F range', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([300, 300]);
        const font = await pdfDocument.embedFont(StandardFonts.Helvetica);
        const fontKey = page.node.newFontDictionary(font.name, font.ref).toString();
        const prefix = encoder.encode([
            'BT', `${fontKey} 16 Tf`, '1 0 0 1 40 160 Tm',
        ].join('\n'));
        const suffix = encoder.encode(`) Tj\nET`);
        appendStream(pdfDocument, page, Uint8Array.from([
            ...prefix,
            ...encoder.encode(`\n<${toHex('Target')}> Tj\n(`),
            0x80, 0x81, 0x8f, 0x90, 0x9f,
            ...suffix,
        ]));

        await applyContentEditsToPdfPage(pdfDocument, page, [makeTextEdit()]);

        expect(await savedPageStreamBytes(pdfDocument))
            .toEqual(expect.arrayContaining([0x80, 0x81, 0x8f, 0x90, 0x9f]));
    });

    it('deletes one shared image occurrence while retaining the other drawing operation', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([300, 300]);
        const image = await pdfDocument.embedPng(makeImageEdit().imageDataUrl);
        page.drawImage(image, { x: 20, y: 30, width: 100, height: 50 });
        page.drawImage(image, { x: 150, y: 30, width: 100, height: 50 });
        await image.embed();

        await applyContentEditsToPdfPage(pdfDocument, page, [makeImageEdit({ deleted: true })]);

        const source = (await savedPageStreams(pdfDocument)).join('\n');
        expect(source.match(/\sDo\b/g)).toHaveLength(1);
        expect(source).toMatch(/1 0 0 1 150 30 cm[\s\S]*\/Image-[\w-]+ Do/);
    });

    it('rejects an ambiguous match without changing any source stream', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([300, 300]);
        const font = await pdfDocument.embedFont(StandardFonts.Helvetica);
        page.drawText('Target', { x: 40, y: 160, size: 16, font });
        page.drawText('Target', { x: 40, y: 160, size: 16, font });
        const before = await savedPageStreams(pdfDocument);

        await expect(applyContentEditsToPdfPage(pdfDocument, page, [makeTextEdit()]))
            .rejects.toBeInstanceOf(ContentRewriteError);

        expect(await savedPageStreams(pdfDocument)).toEqual(before);
    });

    const addSimpleFont = (pdfDocument: PDFDocument, page: PDFPage, font: Record<string, unknown>, toUnicode?: string) => {
        const ToUnicode = toUnicode === undefined ? undefined : pdfDocument.context.register(pdfDocument.context.flateStream(toUnicode));
        const ref = pdfDocument.context.register(pdfDocument.context.obj({
            Type: 'Font', Subtype: 'TrueType', FirstChar: 0, LastChar: 255, Widths: Array.from({ length: 256 }, () => 500), ...font,
            ...(ToUnicode ? { ToUnicode } : {}),
        }));
        return page.node.newFontDictionary('F', ref).toString();
    };
    const holaCMap = [
        'begincmap', '1 begincodespacerange <00> <FF> endcodespacerange',
        '3 beginbfchar <01> <0048> <02> <006F> <03> <006C> endbfchar',
        '1 beginbfrange <04> <04> <0061> endbfrange', 'endcmap',
    ].join('\n');

    it('uses ToUnicode for a subset font with a built-in encoding', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([300, 300]);
        const fontKey = addSimpleFont(pdfDocument, page, { BaseFont: 'ABCDEF+Custom' }, holaCMap);
        appendStream(pdfDocument, page, `BT ${fontKey} 16 Tf 1 0 0 1 40 160 Tm <01020304> Tj ET`);

        await applyContentEditsToPdfPage(pdfDocument, page, [makeTextEdit({ originalText: 'Hola', text: 'aloH' })]);

        expect((await extractTextItems(pdfDocument)).map(item => item.text)).toContain('aloH');
        expect((await savedPageStreams(pdfDocument))[0]).not.toContain('PDFingFallback');
    });

    it('falls back instead of using glyphs a subset font may not embed', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([300, 300]);
        const fontKey = addSimpleFont(pdfDocument, page, { BaseFont: 'ABCDEF+Custom', Encoding: 'WinAnsiEncoding' }, holaCMap);
        appendStream(pdfDocument, page, `BT ${fontKey} 16 Tf 1 0 0 1 40 160 Tm <01020304> Tj ET`);

        await applyContentEditsToPdfPage(pdfDocument, page, [makeTextEdit({ originalText: 'Hola', text: 'Hola!' })]);

        expect((await savedPageStreams(pdfDocument))[0]).toContain('PDFingFallback');
    });

    it('decodes an unsupported named encoding through ToUnicode', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([300, 300]);
        const fontKey = addSimpleFont(pdfDocument, page, { BaseFont: 'Custom', Encoding: 'MacRomanEncoding' }, holaCMap);
        appendStream(pdfDocument, page, `BT ${fontKey} 16 Tf 1 0 0 1 40 160 Tm <01020304> Tj ET`);

        await applyContentEditsToPdfPage(pdfDocument, page, [makeTextEdit({ originalText: 'Hola', text: 'Hola' , pdfX: 60 })]);

        expect((await extractTextItems(pdfDocument)).find(item => item.text === 'Hola')?.transform[4]).toBeCloseTo(60, 2);
    });

    it('reports an undecodable font at the edit position instead of a missing selection', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([300, 300]);
        const fontKey = addSimpleFont(pdfDocument, page, { BaseFont: 'Custom', Encoding: 'MacRomanEncoding' });
        appendStream(pdfDocument, page, `BT ${fontKey} 16 Tf 1 0 0 1 40 160 Tm (Target) Tj ET`);

        await expect(applyContentEditsToPdfPage(pdfDocument, page, [makeTextEdit()]))
            .rejects.toThrow('cannot be edited safely');
    });

    it('rewrites a TrueType font whose encoding dictionary carries /Differences', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([300, 300]);
        const font = pdfDocument.context.register(pdfDocument.context.obj({
            Type: 'Font',
            Subtype: 'TrueType',
            BaseFont: 'Calibri',
            FirstChar: 0,
            LastChar: 255,
            Widths: Array.from({ length: 256 }, () => 500),
            Encoding: { Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding', Differences: [128, 'Euro', 141, 'u008D'] },
        }));
        const fontKey = page.node.newFontDictionary('Calibri', font).toString();
        appendStream(pdfDocument, page, `BT ${fontKey} 16 Tf 1 0 0 1 40 160 Tm (Casta\\361o \\200) Tj ET`);

        await applyContentEditsToPdfPage(pdfDocument, page, [makeTextEdit({ originalText: 'Castaño €', text: 'Pérez €' })]);

        expect((await extractTextItems(pdfDocument)).map(item => item.text).join(' ')).toContain('Pérez €');
        expect((await savedPageStreams(pdfDocument))[0]).not.toContain('PDFingFallback');
    });
});
