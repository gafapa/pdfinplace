export type RasterImageKind = 'png' | 'jpeg';

export interface ImageDimensions {
    width: number;
    height: number;
    kind: RasterImageKind;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_START_OF_FRAME_MARKERS = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

const isPng = (bytes: Uint8Array) =>
    bytes.length >= 24 && PNG_SIGNATURE.every((value, index) => bytes[index] === value);

const readPngDimensions = (bytes: Uint8Array): ImageDimensions => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
        width: view.getUint32(16),
        height: view.getUint32(20),
        kind: 'png',
    };
};

const readJpegDimensions = (bytes: Uint8Array): ImageDimensions | null => {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        return null;
    }

    let offset = 2;
    while (offset + 8 < bytes.length) {
        if (bytes[offset] !== 0xff) {
            offset += 1;
            continue;
        }

        const marker = bytes[offset + 1];
        if (marker === 0xff) {
            offset += 1;
            continue;
        }
        if (
            marker === 0x01 ||
            marker === 0xd8 ||
            marker === 0xd9 ||
            (marker >= 0xd0 && marker <= 0xd7)
        ) {
            offset += 2;
            continue;
        }

        if (offset + 4 > bytes.length) return null;
        const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
        if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length) return null;

        if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
            const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
            const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
            return { width, height, kind: 'jpeg' };
        }

        offset += 2 + segmentLength;
    }

    return null;
};

export const readImageDimensions = (buffer: ArrayBuffer): ImageDimensions | null => {
    const bytes = new Uint8Array(buffer);
    if (isPng(bytes)) return readPngDimensions(bytes);
    return readJpegDimensions(bytes);
};

export const getDataUrlImageKind = (dataUrl: string): RasterImageKind | null => {
    if (/^data:image\/png(?:;|,)/i.test(dataUrl)) return 'png';
    if (/^data:image\/jpe?g(?:;|,)/i.test(dataUrl)) return 'jpeg';
    return null;
};
