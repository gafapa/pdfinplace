import { deflateSync } from 'node:zlib';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, PDFRawStream, type PDFRef } from 'pdf-lib';
import { compressPdfImages, IMAGE_COMPRESSION_SETTINGS, undoPngPredictor, type ImageCodec } from './compressImages';

/** Real JPEG encoder for tests, so decoding and re-encoding are exercised end to end. */
const napiCodec: ImageCodec = {
    encodeJpeg: async (image, width, height, quality) => {
        let source: Parameters<ReturnType<ReturnType<typeof createCanvas>['getContext']>['drawImage']>[0];
        if (image.kind === 'jpeg') {
            source = await loadImage(Buffer.from(image.bytes));
        } else {
            const canvas = createCanvas(image.width, image.height);
            const context = canvas.getContext('2d');
            const pixels = context.createImageData(image.width, image.height);
            for (let from = 0, to = 0; to < pixels.data.length; from += image.components, to += 4) {
                pixels.data[to] = image.data[from];
                pixels.data[to + 1] = image.data[from + (image.components === 3 ? 1 : 0)];
                pixels.data[to + 2] = image.data[from + (image.components === 3 ? 2 : 0)];
                pixels.data[to + 3] = 255;
            }
            context.putImageData(pixels, 0, 0);
            source = canvas;
        }
        const target = createCanvas(width, height);
        target.getContext('2d').drawImage(source, 0, 0, width, height);
        return new Uint8Array(await target.encode('jpeg', Math.round(quality * 100)));
    },
};

/** A grainy gradient, as a scanned photo would be, stored losslessly. */
const gradient = (width: number, height: number, components: 1 | 3) => {
    const data = new Uint8Array(width * height * components);
    let seed = 1;
    const grain = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return (seed % 17) - 8;
    };
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const offset = (y * width + x) * components;
            const shade = 128 + (60 * Math.sin(x / 37) * Math.cos(y / 23));
            data[offset] = shade + grain();
            if (components === 3) {
                data[offset + 1] = ((y * 255) / height) + grain();
                data[offset + 2] = (((x + y) * 127) / (width + height)) + grain();
            }
        }
    }
    return data;
};

/** Applies the PNG "Up" predictor to every row, as many PDF producers do. */
const predictUp = (data: Uint8Array, rowBytes: number) => {
    const rows = data.length / rowBytes;
    const output = new Uint8Array(rows * (rowBytes + 1));
    for (let row = 0; row < rows; row += 1) {
        output[row * (rowBytes + 1)] = 2;
        for (let column = 0; column < rowBytes; column += 1) {
            const above = row > 0 ? data[(row - 1) * rowBytes + column] : 0;
            output[row * (rowBytes + 1) + 1 + column] = (data[row * rowBytes + column] - above) & 0xff;
        }
    }
    return output;
};

const streamOf = (document: PDFDocument, ref: PDFRef) => document.context.lookup(ref) as PDFRawStream;

const addImage = (document: PDFDocument, width: number, height: number, options: { components?: 1 | 3; predictor?: boolean; smask?: PDFRef } = {}) => {
    const components = options.components ?? 3;
    const raw = gradient(width, height, components);
    const encoded = options.predictor ? predictUp(raw, width * components) : raw;
    const dict = document.context.obj({
        Type: 'XObject',
        Subtype: 'Image',
        Width: width,
        Height: height,
        ColorSpace: components === 3 ? 'DeviceRGB' : 'DeviceGray',
        BitsPerComponent: 8,
        Filter: 'FlateDecode',
        ...(options.predictor ? { DecodeParms: { Predictor: 12, Colors: components, BitsPerComponent: 8, Columns: width } } : {}),
        ...(options.smask ? { SMask: options.smask } : {}),
    });
    return document.context.register(PDFRawStream.of(dict, new Uint8Array(deflateSync(encoded))));
};

describe('undoPngPredictor', () => {
    it('restores rows encoded with the Up predictor', () => {
        const data = gradient(7, 5, 3);
        expect(undoPngPredictor(predictUp(data, 21), 21, 3)).toEqual(data);
    });

    it('rejects unknown row filters', () => {
        expect(undoPngPredictor(Uint8Array.of(9, 1, 2, 3), 3, 3)).toBeNull();
    });
});

describe('compressPdfImages', () => {
    it('downscales oversized lossless images to JPEG and keeps soft masks lossless', async () => {
        const document = await PDFDocument.create();
        document.addPage([595, 842]);
        const mask = addImage(document, 400, 300, { components: 1 });
        const photo = addImage(document, 3000, 2000, { predictor: true, smask: mask });
        const gray = addImage(document, 2400, 2400, { components: 1 });

        const result = await compressPdfImages(document, IMAGE_COMPRESSION_SETTINGS.balanced, napiCodec);
        expect(result.compressedImages).toBe(2);
        expect(result.bytesAfter).toBeLessThan(result.bytesBefore);

        // 842 pt is 11.7 in; at 150 ppi the longest side becomes 1754 px.
        const compressed = streamOf(document, photo);
        expect(compressed.dict.get(PDFName.of('Filter'))?.toString()).toBe('/DCTDecode');
        expect(compressed.dict.get(PDFName.of('DecodeParms'))).toBeUndefined();
        expect(compressed.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber()).toBe(1754);
        expect(compressed.dict.get(PDFName.of('SMask'))?.toString()).toBe(mask.toString());

        // Grey images come back as RGB JPEGs.
        const grayImage = streamOf(document, gray);
        expect(grayImage.dict.get(PDFName.of('ColorSpace'))?.toString()).toBe('/DeviceRGB');

        const softMask = streamOf(document, mask);
        expect(softMask.dict.get(PDFName.of('Filter'))?.toString()).toBe('/FlateDecode');

        // The result is still a valid PDF.
        const reloaded = await PDFDocument.load(await document.save());
        expect(reloaded.getPageCount()).toBe(1);
    }, 60_000);

    it('leaves small lossless images alone unless strong compression is chosen', async () => {
        const document = await PDFDocument.create();
        document.addPage([595, 842]);
        const small = addImage(document, 600, 400);
        expect((await compressPdfImages(document, IMAGE_COMPRESSION_SETTINGS.balanced, napiCodec)).compressedImages).toBe(0);
        expect((await compressPdfImages(document, IMAGE_COMPRESSION_SETTINGS.strong, napiCodec)).compressedImages).toBe(1);
        expect(streamOf(document, small).dict.get(PDFName.of('Filter'))?.toString()).toBe('/DCTDecode');
    }, 60_000);

    it('skips images it cannot re-encode faithfully', async () => {
        const document = await PDFDocument.create();
        document.addPage([595, 842]);
        const cmyk = document.context.register(PDFRawStream.of(document.context.obj({
            Type: 'XObject', Subtype: 'Image', Width: 2000, Height: 2000, ColorSpace: 'DeviceCMYK', BitsPerComponent: 8, Filter: 'FlateDecode',
        }), new Uint8Array(deflateSync(new Uint8Array(2000 * 2000 * 4)))));
        const result = await compressPdfImages(document, IMAGE_COMPRESSION_SETTINGS.strong, napiCodec);
        expect(result.compressedImages).toBe(0);
        expect(streamOf(document, cmyk).dict.get(PDFName.of('Filter'))?.toString()).toBe('/FlateDecode');
    });
});
