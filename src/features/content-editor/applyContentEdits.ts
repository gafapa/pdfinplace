import type { PDFDocument, PDFPage } from 'pdf-lib';
import type { ContentEdit } from './types';
import { ContentRewriteError } from './rewriteContentStreams';
import { rewritePageTransaction } from './rewriteFormTransaction';
import { prepareUnicodeFallbackFonts, type UnicodeFontBytes } from './unicodeFallback';

export { ContentRewriteError } from './rewriteContentStreams';

/**
 * Persists content edits by changing the page content stream itself. The
 * rewriter validates every edit before replacing /Contents, so a rejected
 * edit leaves the isolated export page unchanged.
 */
export const applyContentEditsToPdfPage = async (
    _pdfDocument: PDFDocument,
    pdfPage: PDFPage,
    edits: ContentEdit[],
    unicodeFontBytes?: UnicodeFontBytes,
) => {
    // Materialize newly embedded font/image dictionaries before resolving resources.
    await _pdfDocument.flush();
    try {
        return rewritePageTransaction(pdfPage, edits);
    } catch (error) {
        if (!(error instanceof ContentRewriteError) || error.code !== 'fallback-needed') throw error;
    }
    const unicodeFonts = await prepareUnicodeFallbackFonts(_pdfDocument, edits, unicodeFontBytes);
    return rewritePageTransaction(pdfPage, edits, unicodeFonts);
};
