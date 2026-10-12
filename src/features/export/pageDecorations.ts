import type { PDFDocument, PDFFont, PDFPage } from 'pdf-lib';
import type { Annotation, DrawingAnnotationData, ShapeAnnotationData, TextAnnotationData } from '../../types/annotations';
import type { PrintOverlayOptions } from '../../hooks/editorTypes';
import { canvasToPngBytes, getContentBox, getCropZoom, getOverlayFont, hexToRgb, isImageLikeAnnotation, loadPdfLib } from '../../hooks/editorResources';
import { getDataUrlImageKind, readImageDimensions } from '../../utils/imageValidation';
import { MAX_IMAGE_PIXELS } from '../../utils/importValidation';
import { PDFJS_RESOURCE_VERSION } from '../../utils/pdfjsResourceVersion';
import { getArrowHead, getLineEndpoints, HIGHLIGHT_OPACITY } from '../../utils/shapeGeometry';

export interface Size { width: number; height: number }

/** Reads a bundled font by its path relative to the app base URL. */
export type FontBytesLoader = (path: string) => Promise<Uint8Array>;

const defaultFontBytesLoader: FontBytesLoader = async (path) => {
    const response = await fetch(`${import.meta.env.BASE_URL}${path}`);
    if (!response.ok) throw new Error(`Could not load the bundled font ${path} (${response.status}).`);
    return new Uint8Array(await response.arrayBuffer());
};

const liberationSansPath = (bold: boolean, italic: boolean) => {
    const variant = bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular';
    return `pdfjs/${PDFJS_RESOURCE_VERSION}/standard_fonts/LiberationSans-${variant}.ttf`;
};
const CJK_FONT_PATH = 'fonts/NotoSansCJKsc-Regular.otf';

interface BundledFont { bytes: Uint8Array; characterSet: Set<number> }
const bundledFontCache = new Map<string, Promise<BundledFont>>();

const loadBundledFont = (path: string, loader: FontBytesLoader) => {
    let pending = bundledFontCache.get(path);
    if (!pending) {
        pending = (async () => {
            const bytes = await loader(path);
            const { default: fontkit } = await import('@pdf-lib/fontkit');
            return { bytes, characterSet: new Set(fontkit.create(bytes).characterSet) };
        })();
        bundledFontCache.set(path, pending);
        void pending.catch(() => bundledFontCache.delete(path));
    }
    return pending;
};

/**
 * Picks a vector font for each text line: the matching Standard 14 font when it
 * can encode the line, otherwise a bundled Unicode font (Liberation Sans for
 * Latin/Greek/Cyrillic, Noto Sans CJK for CJK) so the text stays selectable.
 */
export const createAnnotationFonts = (document: PDFDocument, loadFontBytes: FontBytesLoader = defaultFontBytesLoader) => {
    const embedded = new Map<string, Promise<PDFFont>>();
    const embedOnce = (key: string, create: () => Promise<PDFFont>) => {
        let pending = embedded.get(key);
        if (!pending) {
            pending = create();
            embedded.set(key, pending);
        }
        return pending;
    };

    const standardFont = async (data: TextAnnotationData) => {
        const { StandardFonts } = await loadPdfLib();
        const isSerif = data.fontFamily === 'Times New Roman' || data.fontFamily === 'Georgia';
        const isMonospace = data.fontFamily === 'Courier New';
        const name = isSerif
            ? (data.bold && data.italic ? StandardFonts.TimesRomanBoldItalic : data.bold ? StandardFonts.TimesRomanBold : data.italic ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman)
            : isMonospace
                ? (data.bold && data.italic ? StandardFonts.CourierBoldOblique : data.bold ? StandardFonts.CourierBold : data.italic ? StandardFonts.CourierOblique : StandardFonts.Courier)
                : (data.bold && data.italic ? StandardFonts.HelveticaBoldOblique : data.bold ? StandardFonts.HelveticaBold : data.italic ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica);
        return embedOnce(name, () => document.embedFont(name));
    };

    const unicodeFont = async (line: string, data: TextAnnotationData) => {
        const codePoints = [...line].map(character => character.codePointAt(0) ?? 0);
        for (const path of [liberationSansPath(data.bold, data.italic), CJK_FONT_PATH]) {
            let bundled: BundledFont;
            try {
                bundled = await loadBundledFont(path, loadFontBytes);
            } catch (error) {
                console.warn('A bundled Unicode font is unavailable:', error);
                continue;
            }
            if (!codePoints.every(codePoint => bundled.characterSet.has(codePoint))) continue;
            return embedOnce(path, async () => {
                const { default: fontkit } = await import('@pdf-lib/fontkit');
                document.registerFontkit(fontkit);
                return document.embedFont(bundled.bytes, { subset: true });
            });
        }
        return null;
    };

    return {
        /** Returns a font able to encode the line, or null when only rasterizing can draw it. */
        forLine: async (line: string, data: TextAnnotationData) => {
            const standard = await standardFont(data);
            try {
                standard.encodeText(line);
                return standard;
            } catch {
                return unicodeFont(line, data);
            }
        },
    };
};
export type AnnotationFonts = ReturnType<typeof createAnnotationFonts>;

/**
 * Draws editor annotations into `area` (the visible page, in its displayed
 * orientation and in PDF user space units). The caller sets up any transform
 * from that area into the page's own coordinate system.
 */
export const drawAnnotations = async (
    pdfPage: PDFPage,
    annotations: Annotation[],
    area: Size,
    editorCanvas: Size,
    overlayOptions: Pick<PrintOverlayOptions, 'marginPercent' | 'cropPercent'>,
    fonts: AnnotationFonts,
) => {
    const pdfLib = await loadPdfLib();
    const marginPercent = Math.max(0, Math.min(overlayOptions.marginPercent, 20));
    const cropPercent = Math.max(0, Math.min(overlayOptions.cropPercent, 20));
    const cropZoom = getCropZoom(cropPercent);
    const contentBox = getContentBox(area.width, area.height, marginPercent);
    const safeEditorWidth = Math.max(1, editorCanvas.width);
    const safeEditorHeight = Math.max(1, editorCanvas.height);
    const scaleX = (contentBox.width / safeEditorWidth) * cropZoom;
    const scaleY = (contentBox.height / safeEditorHeight) * cropZoom;
    const cropInsetX = (safeEditorWidth * cropPercent) / 100;
    const cropInsetY = (safeEditorHeight * cropPercent) / 100;

    const transformCoords = (x: number, y: number) => ({
        x: contentBox.x + ((x - cropInsetX) * scaleX),
        y: contentBox.y + contentBox.height - ((y - cropInsetY) * scaleY),
    });

    const drawRasterizedTextLine = async (
        line: string,
        data: TextAnnotationData,
        x: number,
        topY: number,
        lineHeight: number,
        rotation: number,
    ) => {
        const renderScale = 2;
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Text fallback canvas is unavailable.');

        context.font = `${data.italic ? 'italic ' : ''}${data.bold ? 'bold ' : ''}${data.fontSize * renderScale}px ${data.fontFamily}`;
        const measuredWidth = Math.max(1, Math.ceil(context.measureText(line || ' ').width));
        canvas.width = measuredWidth + 4;
        canvas.height = Math.max(1, Math.ceil(lineHeight * renderScale));
        context.scale(renderScale, renderScale);
        context.font = `${data.italic ? 'italic ' : ''}${data.bold ? 'bold ' : ''}${data.fontSize}px ${data.fontFamily}`;
        context.fillStyle = data.color || '#000000';
        context.textBaseline = 'top';
        context.fillText(line || ' ', 1, 0);

        const image = await pdfPage.doc.embedPng(await canvasToPngBytes(canvas));
        const imageWidth = (canvas.width / renderScale) * scaleX;
        const imageHeight = lineHeight * scaleY;
        pdfPage.drawImage(image, {
            x,
            y: topY - imageHeight,
            width: imageWidth,
            height: imageHeight,
            rotate: pdfLib.degrees(-rotation),
        });
    };

    for (const ann of annotations) {
        const { x, y } = transformCoords(ann.x, ann.y);
        const width = ann.width * scaleX;
        const height = ann.height * scaleY;

        if (ann.type === 'text') {
            const data = ann.data as TextAnnotationData;
            const renderedLines = data.text.split(/\r?\n/);
            const lines = renderedLines.length > 0 ? renderedLines : [''];
            const scaledFontSize = data.fontSize * scaleY;
            const lineHeight = scaledFontSize * 1.25;
            const editorLineHeight = data.fontSize * 1.25;

            for (const [index, line] of lines.entries()) {
                const lineTopY = y - (index * lineHeight);
                const text = line.length > 0 ? line : ' ';
                const font = await fonts.forLine(text, data);
                if (!font) {
                    await drawRasterizedTextLine(line, data, x, lineTopY, editorLineHeight, ann.rotation);
                    continue;
                }
                pdfPage.drawText(text, {
                    x,
                    y: lineTopY - scaledFontSize,
                    size: scaledFontSize,
                    font,
                    color: hexToRgb(data.color || '#000000', pdfLib.rgb),
                    rotate: pdfLib.degrees(-ann.rotation),
                });
            }
        } else if (ann.type === 'drawing') {
            const data = ann.data as DrawingAnnotationData;
            const points = data.points;
            if (points.length < 2) continue;

            for (let i = 0; i < points.length - 1; i++) {
                pdfPage.drawLine({
                    start: transformCoords(points[i].x, points[i].y),
                    end: transformCoords(points[i + 1].x, points[i + 1].y),
                    thickness: data.strokeWidth * Math.min(scaleX, scaleY),
                    color: hexToRgb(data.strokeColor, pdfLib.rgb),
                });
            }
        } else if (ann.type === 'shape') {
            const data = ann.data as ShapeAnnotationData;
            const color = hexToRgb(data.strokeColor, pdfLib.rgb);
            const isHighlight = data.shapeType === 'highlight';
            const fill = data.fillColor ? hexToRgb(data.fillColor, pdfLib.rgb) : undefined;
            const fillOpacity = data.fillOpacity ?? (isHighlight ? HIGHLIGHT_OPACITY : 1);
            const thickness = data.strokeWidth * Math.min(scaleX, scaleY);
            // A zero-width PDF line still paints one device pixel, so skip it entirely.
            const stroke = data.strokeWidth > 0 && !isHighlight;

            if (data.shapeType === 'rectangle' || isHighlight) {
                const p1 = transformCoords(ann.x, ann.y);
                const p2 = transformCoords(ann.x + ann.width, ann.y);
                const p3 = transformCoords(ann.x + ann.width, ann.y + ann.height);
                const p4 = transformCoords(ann.x, ann.y + ann.height);

                if (fill) {
                    // transformCoords only scales and flips Y, so p4 is the bottom-left corner.
                    pdfPage.drawRectangle({
                        x: p4.x,
                        y: p4.y,
                        width: ann.width * scaleX,
                        height: ann.height * scaleY,
                        color: fill,
                        opacity: fillOpacity,
                        blendMode: isHighlight ? pdfLib.BlendMode.Multiply : undefined,
                    });
                }

                if (stroke) {
                    const drawLine = (start: { x: number; y: number }, end: { x: number; y: number }) =>
                        pdfPage.drawLine({ start, end, thickness, color });
                    drawLine(p1, p2);
                    drawLine(p2, p3);
                    drawLine(p3, p4);
                    drawLine(p4, p1);
                }
            } else if (data.shapeType === 'circle') {
                const center = transformCoords(ann.x + ann.width / 2, ann.y + ann.height / 2);
                pdfPage.drawEllipse({
                    x: center.x,
                    y: center.y,
                    xScale: (ann.width / 2) * scaleX,
                    yScale: (ann.height / 2) * scaleY,
                    color: fill,
                    opacity: fill ? fillOpacity : undefined,
                    borderColor: stroke ? color : undefined,
                    borderWidth: stroke ? thickness : 0,
                });
            } else if (data.shapeType === 'line' || data.shapeType === 'arrow') {
                const { start, end } = getLineEndpoints(ann, data);
                const head = data.shapeType === 'arrow' ? getArrowHead(start, end, data.strokeWidth) : null;
                if (stroke) {
                    pdfPage.drawLine({
                        start: transformCoords(start.x, start.y),
                        end: transformCoords(head ? head.shaftEnd.x : end.x, head ? head.shaftEnd.y : end.y),
                        thickness,
                        color,
                        lineCap: pdfLib.LineCapStyle.Round,
                    });
                }
                if (head) {
                    // drawSvgPath flips Y, so negate the PDF y coordinates.
                    const [tip, left, right] = [head.tip, head.left, head.right].map(point => transformCoords(point.x, point.y));
                    pdfPage.drawSvgPath(`M ${tip.x} ${-tip.y} L ${left.x} ${-left.y} L ${right.x} ${-right.y} Z`, { x: 0, y: 0, color });
                }
            }
        } else if (isImageLikeAnnotation(ann)) {
            const dataUrl = ann.data.dataUrl;
            const imageKind = getDataUrlImageKind(dataUrl);
            if (!imageKind) {
                throw new Error('An annotation contains an unsupported image format.');
            }
            const response = await fetch(dataUrl);
            if (!response.ok) {
                throw new Error('An annotation image could not be read.');
            }
            const imageBytes = await response.arrayBuffer();
            const dimensions = readImageDimensions(imageBytes);
            if (!dimensions || dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
                throw new Error('An annotation image is invalid or too large.');
            }
            const image = imageKind === 'png'
                ? await pdfPage.doc.embedPng(imageBytes)
                : await pdfPage.doc.embedJpg(imageBytes);

            pdfPage.drawImage(image, {
                x,
                y: y - height,
                width,
                height,
                rotate: pdfLib.degrees(-ann.rotation),
            });
        }
    }
};

/** Draws watermark, header, footer and page number into the visible page `area`. */
export const drawPrintOverlays = async (
    pdfPage: PDFPage,
    area: Size,
    pageNumber: number,
    totalPages: number,
    options: PrintOverlayOptions,
) => {
    const normalizedWatermark = options.watermarkText.trim();
    const normalizedHeader = options.headerText.trim();
    const normalizedFooter = options.footerText.trim();
    if (!normalizedWatermark && !normalizedHeader && !normalizedFooter && !options.includePageNumbers) return;

    const pdfLib = await loadPdfLib();
    const { width, height } = area;
    const overlayFont = await getOverlayFont(
        pdfPage.doc,
        [normalizedWatermark, normalizedHeader, normalizedFooter],
        pdfLib,
    );

    if (normalizedWatermark) {
        const watermarkSize = Math.max(36, Math.min(width, height) * 0.08);
        const watermarkWidth = overlayFont.widthOfTextAtSize(normalizedWatermark, watermarkSize);

        pdfPage.drawText(normalizedWatermark, {
            x: (width - watermarkWidth) / 2,
            y: height / 2,
            size: watermarkSize,
            font: overlayFont,
            color: pdfLib.rgb(0.72, 0.72, 0.72),
            opacity: 0.22,
            rotate: pdfLib.degrees(35),
        });
    }

    if (options.includePageNumbers) {
        const label = `${pageNumber} / ${totalPages}`;
        const labelSize = Math.max(9, Math.min(width, height) * 0.018);
        const labelWidth = overlayFont.widthOfTextAtSize(label, labelSize);

        pdfPage.drawText(label, {
            x: width - labelWidth - 24,
            y: 18,
            size: labelSize,
            font: overlayFont,
            color: pdfLib.rgb(0.35, 0.35, 0.35),
        });
    }

    if (normalizedHeader) {
        const headerSize = Math.max(10, Math.min(width, height) * 0.018);
        pdfPage.drawText(normalizedHeader, {
            x: 24,
            y: height - headerSize - 18,
            size: headerSize,
            font: overlayFont,
            color: pdfLib.rgb(0.35, 0.35, 0.35),
        });
    }

    if (normalizedFooter) {
        const footerSize = Math.max(10, Math.min(width, height) * 0.018);
        pdfPage.drawText(normalizedFooter, {
            x: 24,
            y: 18,
            size: footerSize,
            font: overlayFont,
            color: pdfLib.rgb(0.35, 0.35, 0.35),
        });
    }
};
