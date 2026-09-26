import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { deflate } from 'pako';
import { BoundedPdfStreamError, decodeBoundedPdfStream } from './decodeBoundedPdfStream';

describe('bounded PDF stream decoding', () => {
    const createFlateStream = async (source: Uint8Array) => {
        const document = await PDFDocument.create();
        const dictionary = PDFDict.withContext(document.context);
        dictionary.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
        return PDFRawStream.of(dictionary, deflate(source));
    };

    it('decodes a stream within its output limit', async () => {
        const source = new TextEncoder().encode('BT /F1 12 Tf (Hello) Tj ET');
        expect(decodeBoundedPdfStream(await createFlateStream(source), 1024)).toEqual(source);
    });

    it('rejects a small compressed stream with excessive decoded output', async () => {
        const stream = await createFlateStream(new Uint8Array(8 * 1024 * 1024));
        expect(stream.getContents().length).toBeLessThan(20 * 1024);
        expect(() => decodeBoundedPdfStream(stream, 1024 * 1024)).toThrow(BoundedPdfStreamError);
    });
});
