import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PDFDocument } from 'pdf-lib';
import type { ContentEdit } from './types';

// The source is immutable; each preview rewrites an isolated copy of one page.
const sourceDocuments = new WeakMap<PDFDocumentProxy, Promise<PDFDocument>>();

export const prepareContentRewrite = (source: PDFDocumentProxy): Promise<PDFDocument> => {
    let sourceDocument = sourceDocuments.get(source);
    if (!sourceDocument) {
        sourceDocument = Promise.all([import('pdf-lib'), source.getData(), import('./applyContentEdits')])
            .then(([{ PDFDocument }, data]) => PDFDocument.load(data));
        sourceDocuments.set(source, sourceDocument);
        void sourceDocument.catch(() => sourceDocuments.delete(source));
    }
    return sourceDocument;
};

export const createRewrittenPreview = async (
    source: PDFDocumentProxy,
    pageNumber: number,
    edits: ContentEdit[],
    onDiagnostics?: (diagnostics: { usedFallbackFont: boolean }) => void,
): Promise<Uint8Array> => {
    const { PDFDocument } = await import('pdf-lib');
    const sourceDocument = prepareContentRewrite(source);
    const document = await PDFDocument.create();
    const [page] = await document.copyPages(await sourceDocument, [pageNumber - 1]);
    document.addPage(page);
    const { applyContentEditsToPdfPage } = await import('./applyContentEdits');
    const diagnostics = await applyContentEditsToPdfPage(document, page, edits);
    onDiagnostics?.({ usedFallbackFont: diagnostics?.usedFallbackFont ?? false });
    return document.save();
};
