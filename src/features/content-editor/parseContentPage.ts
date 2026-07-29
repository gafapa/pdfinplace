import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { loadPdfJs } from '../../utils/pdfjs';
import type {
    ContentBlock,
    ContentEdit,
    ContentFontInfo,
    ParsedContentPage,
    RgbColor,
} from './types';

const MAX_CONTENT_RENDER_PIXELS = 16_000_000;
const MAX_CONTENT_TEXT_ITEMS = 5_000;
const MAX_CONTENT_IMAGES = 50;
const MAX_CONTENT_CAPTURE_PIXELS = 32_000_000;
const MAX_CONTENT_CAPTURE_BYTES = 25 * 1024 * 1024;

type Matrix = [number, number, number, number, number, number];

interface TextStyleSnapshot {
    fillColor: RgbColor;
    strokeColor: RgbColor;
    lineWidth: number;
    renderingMode: number;
}

interface ImageBounds {
    minX: number;
    minY: number;
    width: number;
    height: number;
    rotation: number;
}

interface TextItemLike {
    str: string;
    width: number;
    fontName: string;
    transform: Matrix;
}

interface TextStyleLike {
    fontFamily?: string;
    ascent?: number;
    descent?: number;
}

const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];

const normalizeColorComponent = (value: unknown) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.min(1, numeric > 1 ? numeric / 255 : numeric));
};

const normalizeRgbColor = (color: unknown[]): RgbColor => [
    normalizeColorComponent(color[0]),
    normalizeColorComponent(color[1]),
    normalizeColorComponent(color[2]),
];

const normalizeDegrees = (value: number) => {
    const normalized = value % 360;
    if (normalized > 180) return normalized - 360;
    if (normalized <= -180) return normalized + 360;
    return normalized;
};

const multiplyMatrix = (left: number[], right: number[]): Matrix => {
    const [a1 = 1, b1 = 0, c1 = 0, d1 = 1, e1 = 0, f1 = 0] = left;
    const [a2 = 1, b2 = 0, c2 = 0, d2 = 1, e2 = 0, f2 = 0] = right;

    return [
        a1 * a2 + c1 * b2,
        b1 * a2 + d1 * b2,
        a1 * c2 + c1 * d2,
        b1 * c2 + d1 * d2,
        a1 * e2 + c1 * f2 + e1,
        b1 * e2 + d1 * f2 + f1,
    ];
};

export const transformContentPoint = (matrix: number[], x: number, y: number) => {
    const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = matrix;
    return {
        x: a * x + c * y + e,
        y: b * x + d * y + f,
    };
};

const invertMatrix = (matrix: number[]): Matrix => {
    const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = matrix;
    const determinant = a * d - b * c;

    if (!determinant) {
        throw new Error('Cannot invert a singular PDF viewport transform.');
    }

    return [
        d / determinant,
        -b / determinant,
        -c / determinant,
        a / determinant,
        (c * f - d * e) / determinant,
        (b * e - a * f) / determinant,
    ];
};

export const viewportDeltaToPdfDelta = (viewportTransform: number[], dx: number, dy: number) => {
    const inverse = invertMatrix(viewportTransform);
    const origin = transformContentPoint(inverse, 0, 0);
    const moved = transformContentPoint(inverse, dx, dy);
    return {
        dx: moved.x - origin.x,
        dy: moved.y - origin.y,
    };
};

const boundsFromMatrix = (matrix: number[]) => {
    const points = [
        transformContentPoint(matrix, 0, 0),
        transformContentPoint(matrix, 1, 0),
        transformContentPoint(matrix, 0, 1),
        transformContentPoint(matrix, 1, 1),
    ];
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    return {
        minX,
        minY,
        width: maxX - minX,
        height: maxY - minY,
    };
};

const renderPageToCanvas = async (
    page: PDFPageProxy,
    viewport: ReturnType<PDFPageProxy['getViewport']>,
) => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const canvasContext = canvas.getContext('2d');
    if (!canvasContext) {
        throw new Error('Canvas rendering is unavailable.');
    }

    await page.render({ canvas, canvasContext, viewport }).promise;
    return canvas;
};

const cropCanvasToDataUrl = (
    sourceCanvas: HTMLCanvasElement,
    x: number,
    y: number,
    width: number,
    height: number,
) => {
    const cropX = Math.max(0, Math.floor(x));
    const cropY = Math.max(0, Math.floor(y));
    const cropWidth = Math.min(sourceCanvas.width - cropX, Math.ceil(width));
    const cropHeight = Math.min(sourceCanvas.height - cropY, Math.ceil(height));
    if (cropWidth <= 0 || cropHeight <= 0) return null;

    const canvas = document.createElement('canvas');
    canvas.width = cropWidth;
    canvas.height = cropHeight;
    const context = canvas.getContext('2d');
    if (!context) return null;

    context.drawImage(
        sourceCanvas,
        cropX,
        cropY,
        cropWidth,
        cropHeight,
        0,
        0,
        cropWidth,
        cropHeight,
    );
    return canvas.toDataURL('image/png');
};

const sampleCanvasRgb = (sourceCanvas: HTMLCanvasElement, x: number, y: number): RgbColor | null => {
    const sampleX = Math.max(0, Math.min(sourceCanvas.width - 1, Math.round(x)));
    const sampleY = Math.max(0, Math.min(sourceCanvas.height - 1, Math.round(y)));
    const context = sourceCanvas.getContext('2d');
    if (!context) return null;

    try {
        const [r = 255, g = 255, b = 255] = context.getImageData(sampleX, sampleY, 1, 1).data;
        return [r / 255, g / 255, b / 255];
    } catch {
        return null;
    }
};

const sampleBackgroundColor = (
    sourceCanvas: HTMLCanvasElement,
    block: Pick<ContentBlock, 'x' | 'y' | 'width' | 'height'>,
): RgbColor => {
    const padding = 4;
    const middleX = block.x + block.width / 2;
    const middleY = block.y + block.height / 2;
    const candidates = [
        [block.x - padding, middleY],
        [block.x + block.width + padding, middleY],
        [middleX, block.y - padding],
        [middleX, block.y + block.height + padding],
        [block.x - padding, block.y - padding],
        [block.x + block.width + padding, block.y + block.height + padding],
    ];
    const buckets = new Map<string, { color: RgbColor; count: number }>();

    for (const [x = 0, y = 0] of candidates) {
        const color = sampleCanvasRgb(sourceCanvas, x, y);
        if (!color) continue;
        const key = color.map((value) => Math.round(value * 32)).join(',');
        const bucket = buckets.get(key) ?? { color, count: 0 };
        bucket.count += 1;
        buckets.set(key, bucket);
    }

    return [...buckets.values()].sort((left, right) => right.count - left.count)[0]?.color ?? [1, 1, 1];
};

export const parseContentFontInfo = (
    rawFontName = '',
    pdfJsStyle: TextStyleLike | null = null,
): ContentFontInfo => {
    const postScriptName = rawFontName.replace(/^[A-Z]{6}\+/, '');
    const check = `${postScriptName} ${pdfJsStyle?.fontFamily ?? ''}`.toLowerCase();
    const bold = /bold|heavy|black|demi/i.test(check);
    const italic = /italic|oblique|slanted|inclined/i.test(check);
    let family: ContentFontInfo['family'] = 'sans';
    let cssFamily = pdfJsStyle?.fontFamily ?? 'Arial, Helvetica, sans-serif';

    if (/courier|mono|typewriter|consolas|code|fixed/i.test(check)) {
        family = 'mono';
        cssFamily = pdfJsStyle?.fontFamily ?? '"Courier New", Courier, monospace';
    } else if (/times|roman|garamond|palatino|georgia|caslon|bodoni|charter|minion|cambria|serif/i.test(check)) {
        family = 'serif';
        cssFamily = pdfJsStyle?.fontFamily ?? 'Georgia, "Times New Roman", serif';
    }

    return { bold, italic, family, cssFamily, rawName: postScriptName };
};

const parseOperatorColor = (args: unknown[]): RgbColor | null => {
    if (args.length === 1) {
        return normalizeRgbColor([args[0], args[0], args[0]]);
    }
    if (args.length === 3) {
        return normalizeRgbColor(args);
    }
    if (args.length === 4) {
        const [c, m, y, k] = args.map(normalizeColorComponent);
        return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
    }
    return null;
};

const cloneTextStyle = (style: TextStyleSnapshot): TextStyleSnapshot => ({
    fillColor: [...style.fillColor],
    strokeColor: [...style.strokeColor],
    lineWidth: style.lineWidth,
    renderingMode: style.renderingMode,
});

const extractTextStyles = async (page: PDFPageProxy): Promise<TextStyleSnapshot[]> => {
    const { OPS } = await loadPdfJs();
    const operatorList = await page.getOperatorList();
    const styles: TextStyleSnapshot[] = [];
    const stack: TextStyleSnapshot[] = [];
    let state: TextStyleSnapshot = {
        fillColor: [0, 0, 0],
        strokeColor: [0, 0, 0],
        lineWidth: 1,
        renderingMode: 0,
    };
    const textOperators = new Set([
        OPS.showText,
        OPS.showSpacedText,
        OPS.nextLineShowText,
        OPS.nextLineSetSpacingShowText,
    ]);

    for (let index = 0; index < operatorList.fnArray.length; index += 1) {
        const operation = operatorList.fnArray[index];
        const args = (operatorList.argsArray[index] ?? []) as unknown[];

        if (operation === OPS.save) {
            stack.push(cloneTextStyle(state));
        } else if (operation === OPS.restore) {
            state = stack.pop() ?? {
                fillColor: [0, 0, 0],
                strokeColor: [0, 0, 0],
                lineWidth: 1,
                renderingMode: 0,
            };
        } else if (operation === OPS.setFillRGBColor) {
            state.fillColor = normalizeRgbColor(args);
        } else if (operation === OPS.setFillGray) {
            state.fillColor = normalizeRgbColor([args[0], args[0], args[0]]);
        } else if (operation === OPS.setStrokeRGBColor) {
            state.strokeColor = normalizeRgbColor(args);
        } else if (operation === OPS.setStrokeGray) {
            state.strokeColor = normalizeRgbColor([args[0], args[0], args[0]]);
        } else if (operation === OPS.setLineWidth) {
            state.lineWidth = Math.max(0, Number(args[0]) || 0);
        } else if (operation === OPS.setTextRenderingMode) {
            state.renderingMode = Number.isInteger(args[0]) ? Number(args[0]) : 0;
        } else if (operation === OPS.setFillColor || operation === OPS.setFillColorN) {
            state.fillColor = parseOperatorColor(args) ?? state.fillColor;
        } else if (operation === OPS.setStrokeColor || operation === OPS.setStrokeColorN) {
            state.strokeColor = parseOperatorColor(args) ?? state.strokeColor;
        } else if (textOperators.has(operation)) {
            styles.push(cloneTextStyle(state));
        }
    }

    return styles;
};

const extractImageBounds = async (page: PDFPageProxy): Promise<ImageBounds[]> => {
    const { OPS } = await loadPdfJs();
    const operatorList = await page.getOperatorList();
    const stack: Matrix[] = [];
    const imageBounds: ImageBounds[] = [];
    let currentMatrix: Matrix = [...IDENTITY_MATRIX];
    const imageOperators = new Set([
        OPS.paintImageXObject,
        OPS.paintImageXObjectRepeat,
        OPS.paintInlineImageXObject,
        OPS.paintInlineImageXObjectGroup,
        OPS.paintImageMaskXObject,
        OPS.paintImageMaskXObjectGroup,
        OPS.paintImageMaskXObjectRepeat,
    ].filter((value): value is number => typeof value === 'number'));

    for (let index = 0; index < operatorList.fnArray.length; index += 1) {
        const operation = operatorList.fnArray[index];
        const args = (operatorList.argsArray[index] ?? []) as unknown[];

        if (operation === OPS.save) {
            stack.push([...currentMatrix]);
        } else if (operation === OPS.restore) {
            currentMatrix = stack.pop() ?? [...IDENTITY_MATRIX];
        } else if (operation === OPS.transform) {
            currentMatrix = multiplyMatrix(currentMatrix, args.map(Number));
        } else if (imageOperators.has(operation)) {
            const bounds = boundsFromMatrix(currentMatrix);
            if (bounds.width > 4 && bounds.height > 4) {
                imageBounds.push({
                    ...bounds,
                    rotation: normalizeDegrees(Math.atan2(currentMatrix[1], currentMatrix[0]) * (180 / Math.PI)),
                });
                if (imageBounds.length >= MAX_CONTENT_IMAGES) break;
            }
        }
    }

    return imageBounds;
};

const isTextItem = (item: unknown): item is TextItemLike => {
    if (!item || typeof item !== 'object') return false;
    const candidate = item as Partial<TextItemLike>;
    return typeof candidate.str === 'string' && Array.isArray(candidate.transform);
};

const mergeSavedEdits = (
    blocks: ContentBlock[],
    savedEdits: ContentEdit[],
    viewportTransform: number[],
) => {
    const editMap = new Map(savedEdits.map((edit) => [edit.id, edit]));

    return blocks.map((block) => {
        const edit = editMap.get(block.id);
        if (!edit || edit.type !== block.type) return block;

        const originalPoint = transformContentPoint(viewportTransform, edit.origPdfX, edit.origPdfY);
        const editedPoint = transformContentPoint(viewportTransform, edit.pdfX, edit.pdfY);
        const deltaX = editedPoint.x - originalPoint.x;
        const deltaY = editedPoint.y - originalPoint.y;

        if (block.type === 'text' && edit.type === 'text') {
            return {
                ...block,
                ...edit,
                x: block.origX + deltaX,
                y: block.origY + deltaY,
                origX: block.origX,
                origY: block.origY,
                width: block.width,
                height: block.height,
                screenFontSize: block.screenFontSize,
                screenFontAscent: block.screenFontAscent,
                screenRotation: block.screenRotation,
                isDirty: true,
            };
        }

        if (block.type === 'image' && edit.type === 'image') {
            return {
                ...block,
                ...edit,
                x: block.origX + deltaX,
                y: block.origY + deltaY,
                origX: block.origX,
                origY: block.origY,
                width: block.width,
                height: block.height,
                screenRotation: block.screenRotation,
                isDirty: true,
            };
        }

        return block;
    });
};

export const parseContentPage = async (
    pdfDocument: PDFDocumentProxy,
    pageNumber: number,
    displayRotation: number,
    targetWidth: number,
    targetHeight: number,
    savedEdits: ContentEdit[],
): Promise<ParsedContentPage> => {
    const page = await pdfDocument.getPage(pageNumber);
    const unscaledViewport = page.getViewport({ scale: 1, rotation: displayRotation });
    const scale = Math.min(
        targetWidth / Math.max(1, unscaledViewport.width),
        targetHeight / Math.max(1, unscaledViewport.height),
    );
    const viewport = page.getViewport({ scale, rotation: displayRotation });

    if (
        !Number.isFinite(viewport.width) ||
        !Number.isFinite(viewport.height) ||
        viewport.width <= 0 ||
        viewport.height <= 0 ||
        viewport.width * viewport.height > MAX_CONTENT_RENDER_PIXELS
    ) {
        throw new Error('This PDF page is too large to edit safely.');
    }

    const [textContent, textStyles, imageBounds] = await Promise.all([
        page.getTextContent(),
        extractTextStyles(page).catch(() => []),
        extractImageBounds(page).catch(() => []),
    ]);

    if (textContent.items.length > MAX_CONTENT_TEXT_ITEMS) {
        throw new Error('This PDF page contains too many text elements to edit safely.');
    }

    let styleIndex = 0;
    const blocks: ContentBlock[] = [];
    const viewportTransform = [...viewport.transform];

    textContent.items.forEach((unknownItem, itemIndex) => {
        if (!isTextItem(unknownItem) || !unknownItem.str.trim()) return;
        const item = unknownItem;
        const textStyle = textStyles[styleIndex] ?? {
            fillColor: [0, 0, 0] as RgbColor,
            strokeColor: [0, 0, 0] as RgbColor,
            lineWidth: 1,
            renderingMode: 0,
        };
        styleIndex += 1;

        const [a, b, c, d, pdfX, pdfY] = item.transform;
        const horizontalFontSize = Math.hypot(a, b);
        const verticalFontSize = Math.hypot(c, d);
        const pdfFontSize = verticalFontSize || horizontalFontSize || Math.abs(d) || 12;
        const pdfTextScaleX = horizontalFontSize && pdfFontSize ? horizontalFontSize / pdfFontSize : 1;
        const screenTransform = multiplyMatrix(viewportTransform, item.transform);
        const screenFontSize = pdfFontSize * scale;
        const rawStyle = (textContent.styles?.[item.fontName] ?? null) as TextStyleLike | null;
        const fontInfo = parseContentFontInfo(item.fontName, rawStyle);
        const fontAscentRatio = Number.isFinite(rawStyle?.ascent)
            ? Number(rawStyle?.ascent)
            : Number.isFinite(rawStyle?.descent)
                ? 1 + Number(rawStyle?.descent)
                : 0.8;
        const screenFontAscent = screenFontSize * fontAscentRatio;
        const originalWidth = item.width > 0
            ? item.width
            : item.str.length * pdfFontSize * 0.55;
        const x = screenTransform[4];
        const y = screenTransform[5] - screenFontAscent;

        blocks.push({
            type: 'text',
            id: `${pageNumber - 1}-text-${itemIndex}`,
            pageIndex: pageNumber - 1,
            x,
            y,
            origX: x,
            origY: y,
            width: Math.max(originalWidth * scale, screenFontSize),
            height: screenFontSize,
            pdfX,
            pdfY,
            origPdfX: pdfX,
            origPdfY: pdfY,
            origWidth: originalWidth,
            pdfFontSize,
            pdfTextScaleX,
            screenFontSize,
            screenTextScaleX: pdfTextScaleX,
            screenFontAscent,
            pdfRotation: normalizeDegrees(Math.atan2(b, a) * (180 / Math.PI)),
            screenRotation: normalizeDegrees(Math.atan2(screenTransform[1], screenTransform[0]) * (180 / Math.PI)),
            text: item.str,
            originalText: item.str,
            fontInfo,
            pdfColor: textStyle.fillColor,
            textEffects: {
                renderingMode: textStyle.renderingMode,
                strokeColor: textStyle.strokeColor,
                strokeWidth: textStyle.lineWidth,
                screenStrokeWidth: textStyle.lineWidth * scale,
            },
            backgroundColor: [1, 1, 1],
            isDirty: false,
        });
    });

    if (blocks.length > 0 || imageBounds.length > 0) {
        const pageCanvas = await renderPageToCanvas(page, viewport);
        const captureViewport = displayRotation === page.rotate
            ? viewport
            : page.getViewport({ scale, rotation: page.rotate });
        const imageCaptureCanvas = captureViewport === viewport
            ? pageCanvas
            : await renderPageToCanvas(page, captureViewport);
        const captureTransform = [...captureViewport.transform];

        blocks.forEach((block) => {
            block.backgroundColor = sampleBackgroundColor(pageCanvas, block);
        });

        let capturedPixels = 0;
        let capturedBytes = 0;

        imageBounds.forEach((bounds, imageIndex) => {
            const screenBounds = boundsFromMatrix(multiplyMatrix(viewportTransform, [
                bounds.width,
                0,
                0,
                bounds.height,
                bounds.minX,
                bounds.minY,
            ]));
            if (screenBounds.width < 12 || screenBounds.height < 12) return;
            const imagePixels = Math.ceil(screenBounds.width) * Math.ceil(screenBounds.height);
            if (capturedPixels + imagePixels > MAX_CONTENT_CAPTURE_PIXELS) return;
            const captureBounds = boundsFromMatrix(multiplyMatrix(captureTransform, [
                bounds.width,
                0,
                0,
                bounds.height,
                bounds.minX,
                bounds.minY,
            ]));

            const imageDataUrl = cropCanvasToDataUrl(
                imageCaptureCanvas,
                captureBounds.minX,
                captureBounds.minY,
                captureBounds.width,
                captureBounds.height,
            );
            if (!imageDataUrl) return;
            const estimatedBytes = Math.ceil(imageDataUrl.length * 0.75);
            if (capturedBytes + estimatedBytes > MAX_CONTENT_CAPTURE_BYTES) return;
            capturedPixels += imagePixels;
            capturedBytes += estimatedBytes;

            blocks.push({
                type: 'image',
                id: `${pageNumber - 1}-image-${imageIndex}`,
                pageIndex: pageNumber - 1,
                x: screenBounds.minX,
                y: screenBounds.minY,
                origX: screenBounds.minX,
                origY: screenBounds.minY,
                width: screenBounds.width,
                height: screenBounds.height,
                pdfX: bounds.minX,
                pdfY: bounds.minY,
                pdfWidth: bounds.width,
                pdfHeight: bounds.height,
                pdfRotation: bounds.rotation,
                screenRotation: 0,
                origPdfX: bounds.minX,
                origPdfY: bounds.minY,
                origWidth: bounds.width,
                origHeight: bounds.height,
                backgroundColor: sampleBackgroundColor(pageCanvas, {
                    x: screenBounds.minX,
                    y: screenBounds.minY,
                    width: screenBounds.width,
                    height: screenBounds.height,
                }),
                imageDataUrl,
                isDirty: false,
            });
        });
    }

    return {
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        viewportTransform,
        blocks: mergeSavedEdits(blocks, savedEdits, viewportTransform),
    };
};

export const rgbToCss = (color: RgbColor) => {
    const [red, green, blue] = color.map(normalizeColorComponent);
    return `rgb(${Math.round(red * 255)}, ${Math.round(green * 255)}, ${Math.round(blue * 255)})`;
};
