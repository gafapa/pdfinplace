import type { PDFDict, PDFDocument, PDFObject, PDFRawStream, PDFRef } from 'pdf-lib';
import { loadPdfLib } from '../../hooks/editorResources';
import { BoundedPdfStreamError, decodeBoundedPdfStream } from '../content-editor/decodeBoundedPdfStream';

export type ImageCompressionLevel = 'none' | 'balanced' | 'strong';

export interface ImageCompressionSettings {
    /** Images are downscaled to at most this resolution over the largest page. */
    pixelsPerInch: number;
    /** JPEG quality from 0 to 1. */
    quality: number;
    /** Also re-encode lossless images that need no downscaling. */
    reencodeLossless: boolean;
}

export const IMAGE_COMPRESSION_SETTINGS: Record<Exclude<ImageCompressionLevel, 'none'>, ImageCompressionSettings> = {
    balanced: { pixelsPerInch: 150, quality: 0.75, reencodeLossless: false },
    strong: { pixelsPerInch: 96, quality: 0.6, reencodeLossless: true },
};

export type DecodedImage =
    | { kind: 'jpeg'; bytes: Uint8Array; width: number; height: number }
    | { kind: 'pixels'; data: Uint8Array; width: number; height: number; components: 1 | 3 };

export interface ImageCodec {
    /** Draws the image at the target size and encodes it as an RGB JPEG. */
    encodeJpeg: (image: DecodedImage, width: number, height: number, quality: number) => Promise<Uint8Array>;
}

export interface ImageCompressionResult {
    /** Images that were replaced by a smaller version. */
    compressedImages: number;
    bytesBefore: number;
    bytesAfter: number;
}

// Larger images are left alone rather than decoded into memory.
const MAX_IMAGE_PIXELS = 40_000_000;
// A replacement must save at least this fraction to be worth the generation loss.
const MIN_SAVING = 0.1;

const numberValue = (dict: PDFDict, key: string, pdfLib: typeof import('pdf-lib')) =>
    dict.lookupMaybe(pdfLib.PDFName.of(key), pdfLib.PDFNumber)?.asNumber();

/** Colour components of a colour space the browser can re-encode faithfully, or null. */
const colorComponents = (value: PDFObject | undefined, document: PDFDocument, pdfLib: typeof import('pdf-lib')): 1 | 3 | null => {
    const { PDFArray, PDFName, PDFRawStream: RawStream } = pdfLib;
    const resolved = value ? document.context.lookup(value) : undefined;
    if (resolved instanceof PDFName) {
        const name = resolved.decodeText();
        return name === 'DeviceRGB' ? 3 : name === 'DeviceGray' ? 1 : null;
    }
    if (resolved instanceof PDFArray && resolved.size() >= 2) {
        const family = resolved.lookupMaybe(0, PDFName)?.decodeText();
        if (family === 'CalRGB') return 3;
        if (family === 'CalGray') return 1;
        if (family === 'ICCBased') {
            const profile = resolved.lookup(1);
            const components = profile instanceof RawStream ? numberValue(profile.dict, 'N', pdfLib) : undefined;
            return components === 3 ? 3 : components === 1 ? 1 : null;
        }
    }
    return null;
};

/** Reverses PNG row predictors (PDF /Predictor 10–15) for 8-bit samples. */
export const undoPngPredictor = (data: Uint8Array, rowBytes: number, bytesPerPixel: number): Uint8Array | null => {
    const stride = rowBytes + 1;
    if (data.length < stride || data.length % stride !== 0) return null;
    const rows = data.length / stride;
    const output = new Uint8Array(rows * rowBytes);
    for (let row = 0; row < rows; row += 1) {
        const filter = data[row * stride];
        const input = row * stride + 1;
        const offset = row * rowBytes;
        for (let column = 0; column < rowBytes; column += 1) {
            const raw = data[input + column];
            const left = column >= bytesPerPixel ? output[offset + column - bytesPerPixel] : 0;
            const up = row > 0 ? output[offset - rowBytes + column] : 0;
            const upLeft = row > 0 && column >= bytesPerPixel ? output[offset - rowBytes + column - bytesPerPixel] : 0;
            let value: number;
            switch (filter) {
                case 0: value = raw; break;
                case 1: value = raw + left; break;
                case 2: value = raw + up; break;
                case 3: value = raw + ((left + up) >> 1); break;
                case 4: {
                    const estimate = left + up - upLeft;
                    const distanceLeft = Math.abs(estimate - left);
                    const distanceUp = Math.abs(estimate - up);
                    const distanceUpLeft = Math.abs(estimate - upLeft);
                    value = raw + (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft ? left : distanceUp <= distanceUpLeft ? up : upLeft);
                    break;
                }
                default: return null;
            }
            output[offset + column] = value & 0xff;
        }
    }
    return output;
};

const decodeImage = (stream: PDFRawStream, width: number, height: number, components: 1 | 3, pdfLib: typeof import('pdf-lib')): DecodedImage | null => {
    const { PDFArray, PDFDict: Dict, PDFName } = pdfLib;
    const filterObject = stream.dict.lookup(PDFName.of('Filter'));
    const filters = filterObject instanceof PDFArray ? filterObject.asArray() : filterObject ? [filterObject] : [];
    if (filters.length > 1 || filters.some(filter => !(filter instanceof PDFName))) return null;
    const filter = (filters[0] as import('pdf-lib').PDFName | undefined)?.decodeText();
    if (filter === 'DCTDecode' || filter === 'DCT') {
        return { kind: 'jpeg', bytes: stream.getContents(), width, height };
    }
    if (filter !== undefined && filter !== 'FlateDecode' && filter !== 'Fl') return null;

    const rowBytes = width * components;
    const parms = stream.dict.lookupMaybe(PDFName.of('DecodeParms'), Dict);
    const predictor = parms ? numberValue(parms, 'Predictor', pdfLib) ?? 1 : 1;
    if (predictor !== 1 && predictor < 10) return null;
    if (predictor >= 10) {
        // The row layout must match the image for the predictor to be undone safely.
        const colors = numberValue(parms!, 'Colors', pdfLib) ?? 1;
        const bits = numberValue(parms!, 'BitsPerComponent', pdfLib) ?? 8;
        const columns = numberValue(parms!, 'Columns', pdfLib) ?? 1;
        if (colors !== components || bits !== 8 || columns !== width) return null;
    }
    const expected = predictor >= 10 ? (rowBytes + 1) * height : rowBytes * height;
    let data: Uint8Array;
    try {
        // Allow trailing padding some encoders append after the last row.
        data = filter ? decodeBoundedPdfStream(stream, expected + 4096) : stream.getContents();
    } catch (error) {
        if (error instanceof BoundedPdfStreamError) return null;
        throw error;
    }
    if (data.length < expected) return null;
    data = data.subarray(0, expected);
    if (predictor >= 10) {
        const unpredicted = undoPngPredictor(data, rowBytes, components);
        if (!unpredicted) return null;
        data = unpredicted;
    }
    return { kind: 'pixels', data, width, height, components };
};

/**
 * Downscales and re-encodes the document's raster images as JPEG. Only 8-bit
 * RGB/grey images without colour-key masks or decode arrays are touched, soft
 * masks stay lossless, and an image is replaced only when it gets smaller.
 */
export const compressPdfImages = async (
    document: PDFDocument,
    settings: ImageCompressionSettings,
    codec: ImageCodec,
    checkpoint: () => Promise<void> = async () => {},
): Promise<ImageCompressionResult> => {
    const pdfLib = await loadPdfLib();
    const { PDFArray, PDFBool, PDFName, PDFNumber, PDFRawStream: RawStream, PDFRef: Ref } = pdfLib;
    const result: ImageCompressionResult = { compressedImages: 0, bytesBefore: 0, bytesAfter: 0 };

    const largestSide = Math.max(1, ...document.getPages().map(page => {
        const { width, height } = page.getSize();
        return Math.max(width, height);
    }));
    const maxImageSide = Math.max(64, Math.round((largestSide / 72) * settings.pixelsPerInch));

    const images: Array<[PDFRef, PDFRawStream]> = [];
    const masks = new Set<string>();
    for (const [ref, object] of document.context.enumerateIndirectObjects()) {
        if (!(object instanceof RawStream) || object.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() !== 'Image') continue;
        images.push([ref, object]);
        for (const key of ['SMask', 'Mask']) {
            const mask = object.dict.get(PDFName.of(key));
            if (mask instanceof Ref) masks.add(mask.toString());
        }
    }

    for (const [ref, stream] of images) {
        await checkpoint();
        const { dict } = stream;
        if (masks.has(ref.toString())) continue;
        if (dict.lookupMaybe(PDFName.of('ImageMask'), PDFBool)?.asBoolean()) continue;
        if (dict.get(PDFName.of('Decode')) || dict.lookupMaybe(PDFName.of('Mask'), PDFArray)) continue;
        if (numberValue(dict, 'BitsPerComponent', pdfLib) !== 8) continue;
        const width = numberValue(dict, 'Width', pdfLib) ?? 0;
        const height = numberValue(dict, 'Height', pdfLib) ?? 0;
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_IMAGE_PIXELS) continue;
        const components = colorComponents(dict.get(PDFName.of('ColorSpace')), document, pdfLib);
        if (!components) continue;

        const decoded = decodeImage(stream, width, height, components, pdfLib);
        if (!decoded) continue;
        const scale = Math.min(1, maxImageSide / Math.max(width, height));
        const downscale = scale < 0.95;
        if (!downscale && decoded.kind === 'pixels' && !settings.reencodeLossless) continue;
        const targetWidth = Math.max(1, Math.round(width * scale));
        const targetHeight = Math.max(1, Math.round(height * scale));

        let encoded: Uint8Array;
        try {
            encoded = await codec.encodeJpeg(decoded, targetWidth, targetHeight, settings.quality);
        } catch (error) {
            console.warn('An image could not be recompressed:', error);
            continue;
        }
        const originalSize = stream.getContentsSize();
        if (encoded.length > originalSize * (1 - MIN_SAVING)) continue;

        const replacement = dict.clone(document.context);
        replacement.set(PDFName.of('Width'), PDFNumber.of(targetWidth));
        replacement.set(PDFName.of('Height'), PDFNumber.of(targetHeight));
        replacement.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
        replacement.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
        replacement.delete(PDFName.of('DecodeParms'));
        replacement.delete(PDFName.of('Length'));
        // The browser always encodes three-component JPEGs.
        if (components === 1) replacement.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
        document.context.assign(ref, RawStream.of(replacement, encoded));
        result.compressedImages += 1;
        result.bytesBefore += originalSize;
        result.bytesAfter += encoded.length;
    }
    return result;
};
