import { PDFArray, PDFName, PDFRawStream, type PDFStream, decodePDFRawStream } from 'pdf-lib';
import { Inflate } from 'pako';

export class BoundedPdfStreamError extends Error {}

const OUTPUT_CHUNK_BYTES = 64 * 1024;

export const decodeBoundedPdfStream = (stream: PDFStream, maxBytes: number): Uint8Array => {
    if (!(stream instanceof PDFRawStream)) {
        const content = stream as PDFStream & { getUnencodedContents?: () => Uint8Array };
        if (!content.getUnencodedContents) throw new BoundedPdfStreamError('Unsupported PDF content stream.');
        const bytes = content.getUnencodedContents();
        if (bytes.length > maxBytes) throw new BoundedPdfStreamError('PDF content exceeds the safe rewrite size.');
        return bytes;
    }

    const compressed = stream.getContents();
    const filterObject = stream.dict.lookup(PDFName.of('Filter'));
    const filters = filterObject instanceof PDFArray ? filterObject.asArray() : filterObject ? [filterObject] : [];
    if (filters.length > 1 || filters.some((filter) => !(filter instanceof PDFName) || !['FlateDecode', 'Fl'].includes(filter.decodeText()))) {
        throw new BoundedPdfStreamError('This PDF stream uses an unsupported filter for safe rewriting.');
    }
    if (!filters.length) {
        if (compressed.length > maxBytes) throw new BoundedPdfStreamError('PDF content exceeds the safe rewrite size.');
        return compressed;
    }

    const inflater = new Inflate({ chunkSize: OUTPUT_CHUNK_BYTES });
    let decompressedBytes = 0;
    inflater.onData = (chunk) => {
        decompressedBytes += chunk.length;
        if (decompressedBytes > maxBytes) throw new BoundedPdfStreamError('PDF content exceeds the safe rewrite size.');
    };
    try {
        for (let offset = 0; offset < compressed.length; offset += OUTPUT_CHUNK_BYTES) {
            inflater.push(compressed.subarray(offset, offset + OUTPUT_CHUNK_BYTES), offset + OUTPUT_CHUNK_BYTES >= compressed.length);
            if (inflater.err) throw new BoundedPdfStreamError('Invalid compressed PDF content.');
        }
        if (compressed.length === 0) throw new BoundedPdfStreamError('Invalid compressed PDF content.');
        const decoded = decodePDFRawStream(stream).decode();
        if (decoded.length > maxBytes) throw new BoundedPdfStreamError('PDF content exceeds the safe rewrite size.');
        return decoded;
    } catch (error) {
        if (error instanceof BoundedPdfStreamError) throw error;
        throw new BoundedPdfStreamError('Invalid compressed PDF content.');
    }
};
