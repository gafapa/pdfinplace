import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { ContentRewriteError } from './rewriteContentStreams';
import { findFormImageMatches } from './rewriteFormOccurrences';
import type { ContentEdit } from './types';

const imageEdit = (overrides: Partial<Extract<ContentEdit, { type: 'image' }>> = {}): Extract<ContentEdit, { type: 'image' }> => ({
    id: 'image', pageIndex: 0, type: 'image', x: 5, y: 6, origX: 5, origY: 6, width: 10, height: 20,
    pdfX: 5, pdfY: 6, pdfWidth: 10, pdfHeight: 20, pdfRotation: 0,
    origPdfX: 5, origPdfY: 6, origWidth: 10, origHeight: 20, screenRotation: 0,
    backgroundColor: [1, 1, 1], imageDataUrl: 'data:image/png;base64,', isDirty: true,
    ...overrides,
});

const createNestedFormPage = async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([100, 100]);
    const context = document.context;
    const image = context.register(context.flateStream('', { Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }));
    const formResources = PDFDict.withContext(context);
    const formXObjects = PDFDict.withContext(context);
    formXObjects.set(PDFName.of('Im1'), image);
    formResources.set(PDFName.XObject, formXObjects);
    const form = context.register(context.flateStream('q 10 0 0 20 5 6 cm /Im1 Do Q', {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], Resources: formResources,
    }));
    const pageResources = PDFDict.withContext(context);
    const pageXObjects = PDFDict.withContext(context);
    pageXObjects.set(PDFName.of('Fm1'), form);
    pageResources.set(PDFName.XObject, pageXObjects);
    page.node.set(PDFName.Resources, pageResources);
    page.node.addContentStream(context.register(context.flateStream('/Fm1 Do')));
    return page;
};

describe('nested Form occurrence discovery', () => {
    it('finds a direct image inside a Form with inherited transform and does not mutate the page', async () => {
        const page = await createNestedFormPage();
        const before = page.node.Contents()?.toString();
        const matches = findFormImageMatches(page, [imageEdit()]);

        expect(matches).toHaveLength(1);
        expect(matches[0].imageName).toBe('Im1');
        expect(matches[0].ctm).toEqual([10, 0, 0, 20, 5, 6]);
        expect(page.node.Contents()?.toString()).toBe(before);
    });

    it('rejects ambiguous shared Form occurrences without mutation', async () => {
        const page = await createNestedFormPage();
        page.node.addContentStream(page.doc.context.register(page.doc.context.flateStream('/Fm1 Do')));
        const before = page.node.Contents()?.toString();

        expect(() => findFormImageMatches(page, [imageEdit()])).toThrow(ContentRewriteError);
        expect(page.node.Contents()?.toString()).toBe(before);
    });
});
