import { rgbToCss, transformContentPoint } from './parseContentPage';
import type { ContentEdit, TextContentBlock } from './types';

const MAX_CACHED_IMAGES = 50;
const imageCache = new Map<string, Promise<HTMLImageElement>>();

const loadImage = (dataUrl: string) => {
    const cached = imageCache.get(dataUrl);
    if (cached) return cached;

    const promise = new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Could not render an edited page image.'));
        image.src = dataUrl;
    });
    imageCache.set(dataUrl, promise);
    while (imageCache.size > MAX_CACHED_IMAGES) {
        const oldestKey = imageCache.keys().next().value;
        if (oldestKey === undefined) break;
        imageCache.delete(oldestKey);
    }
    return promise;
};

const getViewportScale = (viewportTransform: number[]) => {
    const [a = 1, b = 0] = viewportTransform;
    return Math.max(0.01, Math.hypot(a, b));
};

const setTextTransform = (
    context: CanvasRenderingContext2D,
    viewportTransform: number[],
    block: TextContentBlock,
    useOriginalPosition: boolean,
) => {
    const point = transformContentPoint(
        viewportTransform,
        useOriginalPosition ? block.origPdfX : block.pdfX,
        useOriginalPosition ? block.origPdfY : block.pdfY,
    );
    const [a = 1, b = 0] = viewportTransform;
    const viewportAngle = Math.atan2(b, a);
    const textAngle = viewportAngle + (block.pdfRotation * Math.PI) / 180;
    context.translate(point.x, point.y);
    context.rotate(textAngle);
    context.scale(block.pdfTextScaleX, 1);
};

const drawTextEdit = (
    context: CanvasRenderingContext2D,
    viewportTransform: number[],
    block: TextContentBlock,
) => {
    const fontSize = Math.max(1, block.pdfFontSize * getViewportScale(viewportTransform));
    const font = `${block.fontInfo.italic ? 'italic ' : ''}${block.fontInfo.bold ? '700 ' : '400 '}${fontSize}px ${block.fontInfo.cssFamily}`;

    context.save();
    setTextTransform(context, viewportTransform, block, true);
    context.font = font;
    context.textBaseline = 'alphabetic';
    context.fillStyle = rgbToCss(block.backgroundColor);
    context.strokeStyle = rgbToCss(block.backgroundColor);
    context.lineWidth = Math.max(2, fontSize * 0.08);
    context.lineJoin = 'round';
    context.strokeText(block.originalText, 0, 0);
    context.fillText(block.originalText, 0, 0);
    context.restore();

    if (block.deleted || !block.text.trim()) return;

    context.save();
    setTextTransform(context, viewportTransform, block, false);
    context.font = font;
    context.textBaseline = 'alphabetic';
    context.fillStyle = rgbToCss(block.pdfColor);
    context.fillText(block.text, 0, 0);
    context.restore();
};

const drawImageCover = (
    context: CanvasRenderingContext2D,
    viewportTransform: number[],
    edit: Extract<ContentEdit, { type: 'image' }>,
) => {
    const points = [
        transformContentPoint(viewportTransform, edit.origPdfX, edit.origPdfY),
        transformContentPoint(viewportTransform, edit.origPdfX + edit.origWidth, edit.origPdfY),
        transformContentPoint(viewportTransform, edit.origPdfX + edit.origWidth, edit.origPdfY + edit.origHeight),
        transformContentPoint(viewportTransform, edit.origPdfX, edit.origPdfY + edit.origHeight),
    ];
    context.save();
    context.fillStyle = rgbToCss(edit.backgroundColor);
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    points.slice(1).forEach((point) => context.lineTo(point.x, point.y));
    context.closePath();
    context.fill();
    context.restore();
};

const drawImageEdit = async (
    context: CanvasRenderingContext2D,
    viewportTransform: number[],
    edit: Extract<ContentEdit, { type: 'image' }>,
) => {
    drawImageCover(context, viewportTransform, edit);
    if (edit.deleted) return;

    const image = await loadImage(edit.imageDataUrl);
    const topLeft = transformContentPoint(
        viewportTransform,
        edit.pdfX,
        edit.pdfY + edit.pdfHeight,
    );
    const topRight = transformContentPoint(
        viewportTransform,
        edit.pdfX + edit.pdfWidth,
        edit.pdfY + edit.pdfHeight,
    );
    const bottomLeft = transformContentPoint(
        viewportTransform,
        edit.pdfX,
        edit.pdfY,
    );

    context.save();
    context.setTransform(
        (topRight.x - topLeft.x) / Math.max(1, image.naturalWidth),
        (topRight.y - topLeft.y) / Math.max(1, image.naturalWidth),
        (bottomLeft.x - topLeft.x) / Math.max(1, image.naturalHeight),
        (bottomLeft.y - topLeft.y) / Math.max(1, image.naturalHeight),
        topLeft.x,
        topLeft.y,
    );
    context.drawImage(image, 0, 0);
    context.restore();
};

export const drawContentEditsPreview = async (
    context: CanvasRenderingContext2D,
    viewportTransform: number[],
    edits: ContentEdit[],
) => {
    for (const edit of edits) {
        if (!edit.isDirty) continue;
        if (edit.type === 'text') {
            drawTextEdit(context, viewportTransform, edit);
        } else {
            await drawImageEdit(context, viewportTransform, edit);
        }
    }
};
