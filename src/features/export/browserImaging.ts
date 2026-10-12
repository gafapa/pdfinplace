import { canvasToImageBlob, toArrayBuffer } from '../../hooks/editorResources';
import { MAX_RENDER_PIXELS } from '../../utils/importValidation';
import { loadPdfDocumentWithTask, loadPdfJs } from '../../utils/pdfjs';
import type { DecodedImage, ImageCodec } from './compressImages';
import type { PageRasterizer } from './redaction';

// Redacted pages are rasterized at print-like resolution.
const REDACTION_PIXELS_PER_INCH = 200;
const REDACTION_MAX_PIXELS = Math.min(MAX_RENDER_PIXELS, 16_000_000);
const REDACTION_JPEG_QUALITY = 0.92;

const releaseCanvas = (canvas: HTMLCanvasElement) => {
    canvas.width = 1;
    canvas.height = 1;
};

export const rasterizePageInBrowser: PageRasterizer = async ({ pdfBytes, rotation, redactions }) => {
    const pdfJs = await loadPdfJs();
    const loaded = await loadPdfDocumentWithTask({ data: toArrayBuffer(pdfBytes) });
    const canvas = document.createElement('canvas');
    try {
        const page = await loaded.pdfDoc.getPage(1);
        const totalRotation = (((page.rotate + rotation) % 360) + 360) % 360;
        const base = page.getViewport({ scale: 1, rotation: totalRotation });
        const scale = Math.min(REDACTION_PIXELS_PER_INCH / 72, Math.sqrt(REDACTION_MAX_PIXELS / (base.width * base.height)));
        const viewport = page.getViewport({ scale, rotation: totalRotation });
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas is unavailable for redaction.');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({
            canvas,
            canvasContext: context,
            viewport,
            background: '#ffffff',
            // Draw stored appearances (including filled form values) into the image.
            annotationMode: pdfJs.AnnotationMode.ENABLE,
        }).promise;
        context.fillStyle = '#000000';
        for (const area of redactions) {
            // Round outwards so anti-aliased edges cannot leak a sliver of content.
            const left = Math.floor(area.x * canvas.width);
            const top = Math.floor(area.y * canvas.height);
            const right = Math.ceil((area.x + area.width) * canvas.width);
            const bottom = Math.ceil((area.y + area.height) * canvas.height);
            context.fillRect(left, top, right - left, bottom - top);
        }
        const blob = await canvasToImageBlob(canvas, 'image/jpeg', REDACTION_JPEG_QUALITY);
        return { bytes: new Uint8Array(await blob.arrayBuffer()), format: 'jpeg' };
    } finally {
        releaseCanvas(canvas);
        await loaded.loadingTask.destroy().catch(() => {});
    }
};

const drawDecodedImage = async (image: DecodedImage): Promise<{ source: CanvasImageSource; release: () => void }> => {
    if (image.kind === 'jpeg') {
        // PDF viewers ignore EXIF orientation, so the pixels must stay as stored.
        const bitmap = await createImageBitmap(new Blob([toArrayBuffer(image.bytes)], { type: 'image/jpeg' }), { imageOrientation: 'none' });
        if (bitmap.width !== image.width || bitmap.height !== image.height) {
            bitmap.close();
            throw new Error('The JPEG size does not match the image dictionary.');
        }
        return { source: bitmap, release: () => bitmap.close() };
    }
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable for image compression.');
    const pixels = context.createImageData(image.width, image.height);
    const { data, components } = image;
    for (let source = 0, target = 0; target < pixels.data.length; source += components, target += 4) {
        const red = data[source];
        pixels.data[target] = red;
        pixels.data[target + 1] = components === 3 ? data[source + 1] : red;
        pixels.data[target + 2] = components === 3 ? data[source + 2] : red;
        pixels.data[target + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    return { source: canvas, release: () => releaseCanvas(canvas) };
};

export const browserImageCodec: ImageCodec = {
    encodeJpeg: async (image, width, height, quality) => {
        const { source, release } = await drawDecodedImage(image);
        const canvas = document.createElement('canvas');
        try {
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Canvas is unavailable for image compression.');
            context.imageSmoothingEnabled = true;
            context.imageSmoothingQuality = 'high';
            context.drawImage(source, 0, 0, width, height);
            const blob = await canvasToImageBlob(canvas, 'image/jpeg', quality);
            return new Uint8Array(await blob.arrayBuffer());
        } finally {
            release();
            releaseCanvas(canvas);
        }
    },
};
