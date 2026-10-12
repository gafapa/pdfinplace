import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { decodePDFRawStream, degrees, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFString, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { EditorFile, EditorPage, PageSize, PrintOverlayOptions } from '../../hooks/editorTypes';
import type { Annotation, ShapeAnnotationData } from '../../types/annotations';
import { buildPdfDocument } from './buildPdfDocument';

const noOverlays: PrintOverlayOptions = {
    watermarkText: '',
    includePageNumbers: false,
    headerText: '',
    footerText: '',
    cropPercent: 0,
    marginPercent: 0,
};
const loadFontBytes = async (path: string) => new Uint8Array(await readFile(`public/${path}`));

const asEditorFile = (id: string, bytes: Uint8Array): EditorFile => ({
    id,
    file: new File([bytes.slice()], `${id}.pdf`, { type: 'application/pdf' }),
    pageCount: 0,
});
const page = (fileId: string, pageIndex: number, overrides: Partial<EditorPage> = {}): EditorPage => ({
    id: `${fileId}-${pageIndex}-${Math.random()}`,
    fileId,
    pageIndex,
    rotation: 0,
    annotations: [],
    contentEdits: [],
    ...overrides,
});
const build = (pages: EditorPage[], files: EditorFile[], pageSize: PageSize = 'Original', printOverlayOptions = noOverlays) =>
    buildPdfDocument({
        sourcePages: pages,
        files: Object.fromEntries(files.map(file => [file.id, file])),
        pageSize,
        printOverlayOptions,
        loadFontBytes,
    });

/** Text items with their position from the top-left of the rendered page, as fractions of its size. */
const renderedText = async (bytes: Uint8Array, pageNumber = 1) => {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({ data: bytes.slice(), useWorkerFetch: false, verbosity: 0 });
    const pdf = await task.promise;
    const pdfPage = await pdf.getPage(pageNumber);
    const viewport = pdfPage.getViewport({ scale: 1, rotation: pdfPage.rotate });
    const items = (await pdfPage.getTextContent()).items.flatMap(item => {
        if (!('str' in item) || !item.str.trim()) return [];
        const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
        return [{ text: item.str, x: x / viewport.width, y: y / viewport.height }];
    });
    const size = { width: viewport.width, height: viewport.height };
    await task.destroy();
    return { items, size };
};

/** A4 portrait source with a marker near the top-left corner. */
const markerSource = async (rotate = 0) => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const pdfPage = document.addPage([595.28, 841.89]);
    pdfPage.drawText('MARKER', { x: 40, y: 790, size: 14, font });
    if (rotate) pdfPage.setRotation(degrees(rotate));
    return document.save();
};

const textAnnotation = (text: string, x: number, y: number): Annotation => ({
    id: `text-${text}`,
    type: 'text',
    x,
    y,
    width: 200,
    height: 30,
    rotation: 0,
    data: { text, fontSize: 16, fontFamily: 'Arial', color: '#000000', bold: false, italic: false },
});

describe('buildPdfDocument', () => {
    it('copies shared fonts and images once and keeps links, form fields and title', async () => {
        const source = await PDFDocument.create();
        source.registerFontkit(fontkit);
        const font = await source.embedFont(await loadFontBytes(`pdfjs/${(await import('../../utils/pdfjsResourceVersion')).PDFJS_RESOURCE_VERSION}/standard_fonts/LiberationSans-Regular.ttf`), { subset: false });
        const image = await source.embedPng(await readFile('public/pwa-512.png'));
        for (let index = 0; index < 20; index += 1) {
            const pdfPage = source.addPage([595, 842]);
            pdfPage.drawText(`Page ${index + 1}`, { x: 50, y: 780, size: 18, font });
            pdfPage.drawImage(image, { x: 50, y: 400, width: 200, height: 200 });
        }
        const first = source.getPage(0);
        const link = source.context.register(source.context.obj({
            Type: 'Annot', Subtype: 'Link', Rect: [50, 770, 300, 800], Border: [0, 0, 0],
            A: { S: 'URI', URI: PDFString.of('https://example.com') },
        }));
        first.node.set(PDFName.of('Annots'), source.context.obj([link]));
        source.getForm().createTextField('customer.name').addToPage(first, { x: 50, y: 300, width: 200, height: 24 });
        source.setTitle('Quarterly report');
        const sourceBytes = await source.save();
        const file = asEditorFile('report', sourceBytes);
        const pages = Array.from({ length: 20 }, (_, index) => page('report', index + 1));

        const preserved = await build(pages, [file]);
        const reloaded = await PDFDocument.load(preserved);
        expect(preserved.length).toBeLessThan(sourceBytes.length * 1.2);
        expect(reloaded.getPageCount()).toBe(20);
        expect(reloaded.getForm().getFields().map(field => field.getName())).toEqual(['customer.name']);
        expect(reloaded.getPage(0).node.Annots()?.size()).toBe(2);
        expect(reloaded.getTitle()).toBe('Quarterly report');

        const resized = await build(pages, [file], 'A4');
        expect(resized.length).toBeLessThan(sourceBytes.length * 1.2);
    });

    it.each([0, 90, 180, 270])('rotates %i° clockwise like the preview, whether copied or embedded', async (rotation) => {
        const file = asEditorFile('marker', await markerSource());
        // Same rotation as pdf.js gives the preview: the top-left marker turns with the page.
        const expected = {
            0: { x: 0.07, y: 0.07 },
            90: { x: 0.93, y: 0.07 },
            180: { x: 0.93, y: 0.93 },
            270: { x: 0.07, y: 0.93 },
        }[rotation]!;
        for (const pageSize of ['Original', 'A4'] as const) {
            const { items } = await renderedText(await build([page('marker', 1, { rotation })], [file], pageSize));
            const marker = items.find(item => item.text === 'MARKER')!;
            expect(Math.abs(marker.x - expected.x), `${pageSize} x`).toBeLessThan(0.12);
            expect(Math.abs(marker.y - expected.y), `${pageSize} y`).toBeLessThan(0.12);
        }
    });

    it('keeps a source /Rotate page oriented as displayed', async () => {
        const file = asEditorFile('scan', await markerSource(90));
        for (const pageSize of ['Original', 'A4'] as const) {
            const { items, size } = await renderedText(await build([page('scan', 1)], [file], pageSize));
            const marker = items.find(item => item.text === 'MARKER')!;
            expect(size.width).toBeGreaterThan(size.height);
            expect(marker.x).toBeGreaterThan(0.8);
            expect(marker.y).toBeLessThan(0.2);
        }
    });

    it('draws annotations where they were placed on a rotated page', async () => {
        const file = asEditorFile('marker', await markerSource());
        // Editor canvas of the rotated (landscape) page: annotation near its top-left corner.
        const annotated = page('marker', 1, {
            rotation: 90,
            annotationCanvasWidth: 1000,
            annotationCanvasHeight: 707,
            annotations: [textAnnotation('NOTE', 50, 40)],
        });
        for (const pageSize of ['Original', 'A4'] as const) {
            const { items } = await renderedText(await build([annotated], [file], pageSize));
            const note = items.find(item => item.text === 'NOTE')!;
            expect(note.x, pageSize).toBeLessThan(0.1);
            expect(note.y, pageSize).toBeLessThan(0.15);
        }
    });

    it('exports a page used twice and draws print overlays on copied pages', async () => {
        const file = asEditorFile('marker', await markerSource());
        const bytes = await build(
            [page('marker', 1), page('marker', 1, { rotation: 90 })],
            [file],
            'Original',
            { ...noOverlays, includePageNumbers: true },
        );
        const reloaded = await PDFDocument.load(bytes);
        expect(reloaded.getPageCount()).toBe(2);
        expect(reloaded.getPage(1).getRotation().angle).toBe(90);
        const { items } = await renderedText(bytes, 2);
        const label = items.find(item => item.text === '2 / 2')!;
        expect(label.x).toBeGreaterThan(0.8);
        expect(label.y).toBeGreaterThan(0.9);
    });

    it('exports highlights as translucent multiply fills and arrows with a head', async () => {
        const file = asEditorFile('marker', await markerSource());
        const shape = (id: string, data: Partial<ShapeAnnotationData>): Annotation => ({
            id, type: 'shape', x: 40, y: 40, width: 200, height: 40, rotation: 0,
            data: { shapeType: 'rectangle', strokeColor: '#ff0000', fillColor: '', strokeWidth: 2, x1: 0, y1: 0, x2: 1, y2: 1, ...data },
        });
        const bytes = await build([page('marker', 1, {
            annotationCanvasWidth: 707,
            annotationCanvasHeight: 1000,
            annotations: [
                shape('highlight', { shapeType: 'highlight', fillColor: '#ffd60a', fillOpacity: 0.4, strokeWidth: 0 }),
                shape('arrow', { shapeType: 'arrow', strokeWidth: 4 }),
            ],
        })], [file]);
        const reloaded = await PDFDocument.load(bytes);
        const resources = reloaded.getPage(0).node.Resources()!;
        const states = resources.lookup(PDFName.of('ExtGState'), PDFDict);
        const blendModes = states.entries().map(([, ref]) => reloaded.context.lookup(ref, PDFDict).get(PDFName.of('BM'))?.toString());
        expect(blendModes).toContain('/Multiply');
        // The arrow head is a filled path: a closed triangle ("h") filled with "f".
        const contents = reloaded.getPage(0).node.Contents()!;
        const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
        const source = streams.map(ref => {
            const stream = reloaded.context.lookup(ref);
            return stream instanceof PDFRawStream ? new TextDecoder('latin1').decode(decodePDFRawStream(stream).decode()) : '';
        }).join('\n');
        expect(source).toMatch(/\bh\s+f\b/);
    });

    it('writes non-Latin annotation text as selectable vector text', async () => {
        const file = asEditorFile('marker', await markerSource());
        const bytes = await build([page('marker', 1, {
            annotationCanvasWidth: 707,
            annotationCanvasHeight: 1000,
            annotations: [textAnnotation('Привет мир', 50, 200), textAnnotation('你好世界', 50, 300)],
        })], [file]);
        const text = (await renderedText(bytes)).items.map(item => item.text).join(' ');
        expect(text).toContain('Привет мир');
        expect(text).toContain('你好世界');
    }, 60_000);
});
