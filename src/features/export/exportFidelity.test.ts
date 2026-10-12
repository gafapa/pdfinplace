import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFString, StandardFonts } from 'pdf-lib';
import type { EditorFile, EditorPage, PageSize, PrintOverlayOptions } from '../../hooks/editorTypes';
import type { Annotation } from '../../types/annotations';
import { buildPdfDocument } from './buildPdfDocument';
import type { PageRasterizer } from './redaction';

const noOverlays: PrintOverlayOptions = { watermarkText: '', includePageNumbers: false, headerText: '', footerText: '', cropPercent: 0, marginPercent: 0 };
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
// A 1×1 white PNG, standing in for a rendered page.
const WHITE_PIXEL_PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC'), character => character.charCodeAt(0));

const build = (pages: EditorPage[], files: EditorFile[], pageSize: PageSize = 'Original', rasterizePage?: PageRasterizer) =>
    buildPdfDocument({
        sourcePages: pages,
        files: Object.fromEntries(files.map(file => [file.id, file])),
        pageSize,
        printOverlayOptions: noOverlays,
        loadFontBytes,
        rasterizePage,
    });

const renderedText = async (bytes: Uint8Array, pageNumber = 1) => {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({ data: bytes.slice(), useWorkerFetch: false, verbosity: 0 });
    const pdf = await task.promise;
    const pdfPage = await pdf.getPage(pageNumber);
    const viewport = pdfPage.getViewport({ scale: 1 });
    const items = (await pdfPage.getTextContent()).items.flatMap(item => {
        if (!('str' in item) || !item.str.trim()) return [];
        const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
        return [{ text: item.str, x: x / viewport.width, y: y / viewport.height }];
    });
    const annotations = await pdfPage.getAnnotations();
    await task.destroy();
    return { items, annotations };
};

/** Every stream in the file, decoded, so tests can look for leaked content. */
const allStreamText = async (bytes: Uint8Array) => {
    const document = await PDFDocument.load(bytes);
    return document.context.enumerateIndirectObjects().flatMap(([, object]) => {
        if (!(object instanceof PDFRawStream)) return [];
        try {
            return [new TextDecoder('latin1').decode(decodePDFRawStream(object).decode())];
        } catch {
            return [];
        }
    }).join('\n');
};
const hex = (text: string) => [...text].map(character => character.charCodeAt(0).toString(16).padStart(2, '0')).join('').toUpperCase();
const containsText = (streams: string, text: string) => streams.includes(text) || streams.toUpperCase().includes(hex(text));

/** Two A4 pages: page 1 links to the web and to page 2; page 2 holds a secret. */
const linkedSource = async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const first = document.addPage([595.28, 841.89]);
    const second = document.addPage([595.28, 841.89]);
    first.drawText('INDEX', { x: 40, y: 790, size: 14, font });
    second.drawText('SECRET', { x: 40, y: 790, size: 14, font });
    const web = document.context.register(document.context.obj({
        Type: 'Annot', Subtype: 'Link', Rect: [40, 700, 240, 730], Border: [0, 0, 0],
        A: { S: 'URI', URI: PDFString.of('https://example.com/docs') },
    }));
    const internal = document.context.register(document.context.obj({
        Type: 'Annot', Subtype: 'Link', Rect: [40, 600, 240, 630], Border: [0, 0, 0],
        Dest: [second.ref, PDFName.of('Fit')],
    }));
    first.node.set(PDFName.of('Annots'), document.context.obj([web, internal]));
    return document.save();
};

/** One page with a text field, a check box and a radio group. */
const formSource = async () => {
    const document = await PDFDocument.create();
    const pdfPage = document.addPage([595.28, 841.89]);
    const form = document.getForm();
    form.createTextField('customer.name').addToPage(pdfPage, { x: 40, y: 700, width: 300, height: 30 });
    form.createCheckBox('agree').addToPage(pdfPage, { x: 40, y: 640, width: 20, height: 20 });
    const plan = form.createRadioGroup('plan');
    plan.addOptionToPage('basic', pdfPage, { x: 40, y: 580, width: 20, height: 20 });
    plan.addOptionToPage('premium', pdfPage, { x: 100, y: 580, width: 20, height: 20 });
    return document.save();
};

const redactionBox = (x: number, y: number, width: number, height: number): Annotation => ({
    id: `redaction-${x}-${y}`, type: 'shape', x, y, width, height, rotation: 0,
    data: { shapeType: 'redaction', strokeColor: '#000000', fillColor: '#000000', fillOpacity: 1, strokeWidth: 0 },
});

describe('export fidelity', () => {
    it('keeps web and internal links when pages are resized', async () => {
        const file = asEditorFile('linked', await linkedSource());
        const bytes = await build([page('linked', 1), page('linked', 2)], [file], 'Letter');
        const reloaded = await PDFDocument.load(bytes);
        const annots = reloaded.getPage(0).node.Annots()!;
        expect(annots.size()).toBe(2);
        const links = annots.asArray().map(ref => reloaded.context.lookup(ref, PDFDict));
        const web = links.find(link => link.lookup(PDFName.of('A'), PDFDict).get(PDFName.of('S'))?.toString() === '/URI')!;
        expect(web.lookup(PDFName.of('A'), PDFDict).lookup(PDFName.of('URI'), PDFString).decodeText()).toBe('https://example.com/docs');
        // The rectangle moved with the page: Letter is wider and shorter than A4.
        const [x1, , x2] = web.lookup(PDFName.of('Rect'), PDFArray).asArray().map(value => Number(value.toString()));
        expect(x2 - x1).toBeLessThan(200);
        const internal = links.find(link => link !== web)!;
        const destination = internal.lookup(PDFName.of('A'), PDFDict).lookup(PDFName.of('D'), PDFArray);
        expect(destination.get(0).toString()).toBe(reloaded.getPage(1).ref.toString());
    });

    it('drops links to pages that were not exported, and their copies', async () => {
        const file = asEditorFile('linked', await linkedSource());
        for (const pageSize of ['Original', 'A4'] as const) {
            const bytes = await build([page('linked', 1)], [file], pageSize);
            expect(containsText(await allStreamText(bytes), 'SECRET'), pageSize).toBe(false);
            expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
        }
    });

    it('writes filled form values, keeping fields interactive at the original size', async () => {
        const sourceBytes = await formSource();
        const file = asEditorFile('form', sourceBytes);
        // Radio values are widget on-state names, as pdf.js reports them (here /Opt indices).
        const premiumState = (await PDFDocument.load(sourceBytes)).getForm().getRadioGroup('plan').acroField.getOnValues()[1].decodeText();
        const formValues = { 'customer.name': 'Ana Pérez', agree: true, plan: premiumState };
        const bytes = await build([page('form', 1, { formValues })], [file]);
        const form = (await PDFDocument.load(bytes)).getForm();
        expect(form.getTextField('customer.name').getText()).toBe('Ana Pérez');
        expect(form.getCheckBox('agree').isChecked()).toBe(true);
        expect(form.getRadioGroup('plan').getSelected()).toBe('premium');
    });

    it('flattens filled fields into resized pages, in any script', async () => {
        const file = asEditorFile('form', await formSource());
        const bytes = await build([page('form', 1, { formValues: { 'customer.name': 'Анна 李' } })], [file], 'A4');
        const { items, annotations } = await renderedText(bytes);
        expect(items.map(item => item.text).join(' ')).toContain('Анна 李');
        expect(annotations).toHaveLength(0);
    }, 60_000);

    it('rasterizes redacted pages so nothing under the box survives', async () => {
        const file = asEditorFile('linked', await linkedSource());
        const rasterize = vi.fn<PageRasterizer>(async () => ({ bytes: WHITE_PIXEL_PNG, format: 'png' }));
        const redacted = page('linked', 2, {
            rotation: 90,
            annotationCanvasWidth: 1000,
            annotationCanvasHeight: 707,
            annotations: [redactionBox(100, 70.7, 200, 141.4)],
        });
        for (const pageSize of ['Original', 'A4'] as const) {
            rasterize.mockClear();
            // Page 1 links to page 2, which used to drag an unredacted copy along.
            const bytes = await build([page('linked', 1), redacted], [file], pageSize, rasterize);
            expect(rasterize).toHaveBeenCalledTimes(1);
            const request = rasterize.mock.calls[0][0];
            expect(request.rotation).toBe(90);
            expect(request.redactions[0].x).toBeCloseTo(0.1);
            expect(request.redactions[0].y).toBeCloseTo(0.1);
            expect(request.redactions[0].width).toBeCloseTo(0.2);
            expect(containsText(await allStreamText(bytes), 'SECRET'), pageSize).toBe(false);
            const reloaded = await PDFDocument.load(bytes);
            const { width, height } = reloaded.getPage(1).getSize();
            // The rotation is baked into the image: the page is landscape and unrotated.
            expect(width).toBeGreaterThan(height);
            expect(reloaded.getPage(1).getRotation().angle).toBe(0);
            // The internal link now points at the redacted page itself.
            const links = reloaded.getPage(0).node.Annots()!.asArray().map(ref => reloaded.context.lookup(ref, PDFDict));
            const pageTargets = links.flatMap(link => {
                const destination = link.lookupMaybe(PDFName.of('Dest'), PDFArray)
                    ?? link.lookupMaybe(PDFName.of('A'), PDFDict)?.lookupMaybe(PDFName.of('D'), PDFArray);
                return destination ? [destination.get(0).toString()] : [];
            });
            for (const target of pageTargets) {
                expect([reloaded.getPage(0).ref.toString(), reloaded.getPage(1).ref.toString(), 'null']).toContain(target);
            }
        }
    });

    it('refuses to export redactions without a rasterizer', async () => {
        const file = asEditorFile('linked', await linkedSource());
        await expect(build([page('linked', 2, { annotations: [redactionBox(0, 0, 10, 10)] })], [file])).rejects.toThrow(/rasterizer/);
    });
});
