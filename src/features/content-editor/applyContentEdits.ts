import {
    StandardFonts,
    TextRenderingMode,
    beginText,
    degrees,
    endText,
    popGraphicsState,
    pushGraphicsState,
    rgb,
    rotateAndSkewTextDegreesAndTranslate,
    setCharacterSqueeze,
    setFillingColor,
    setFontAndSize,
    setLineWidth,
    setStrokingColor,
    setTextRenderingMode,
    showText,
    type PDFDocument,
    type PDFFont,
    type PDFName,
    type PDFOperator,
    type PDFPage,
} from 'pdf-lib';
import type { ContentEdit, ContentFontInfo, RgbColor, TextContentBlock } from './types';

const UNICODE_FONT_PATH = `${import.meta.env.BASE_URL}pdfjs/standard_fonts/LiberationSans-Regular.ttf`;
const DEFAULT_TEXT_COVER_PADDING = 4;

type FontCache = Record<string, PDFFont | undefined>;

const normalizeColorComponent = (value: unknown) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.min(1, numeric > 1 ? numeric / 255 : numeric));
};

const normalizeColor = (color: RgbColor): RgbColor => [
    normalizeColorComponent(color[0]),
    normalizeColorComponent(color[1]),
    normalizeColorComponent(color[2]),
];

const pickStandardFont = ({ bold, italic, family }: ContentFontInfo) => {
    if (family === 'mono') {
        if (bold && italic) return StandardFonts.CourierBoldOblique;
        if (bold) return StandardFonts.CourierBold;
        if (italic) return StandardFonts.CourierOblique;
        return StandardFonts.Courier;
    }

    if (family === 'serif') {
        if (bold && italic) return StandardFonts.TimesRomanBoldItalic;
        if (bold) return StandardFonts.TimesRomanBold;
        if (italic) return StandardFonts.TimesRomanItalic;
        return StandardFonts.TimesRoman;
    }

    if (bold && italic) return StandardFonts.HelveticaBoldOblique;
    if (bold) return StandardFonts.HelveticaBold;
    if (italic) return StandardFonts.HelveticaOblique;
    return StandardFonts.Helvetica;
};

const fetchUnicodeFontBytes = async () => {
    const response = await fetch(UNICODE_FONT_PATH);
    if (!response.ok) {
        throw new Error(`Could not load the Unicode fallback font (${response.status}).`);
    }
    return response.arrayBuffer();
};

const getUnicodeFont = async (pdfDocument: PDFDocument, fontCache: FontCache) => {
    if (!fontCache.unicode) {
        const { default: fontkit } = await import('@pdf-lib/fontkit');
        pdfDocument.registerFontkit(fontkit);
        fontCache.unicode = await pdfDocument.embedFont(await fetchUnicodeFontBytes(), { subset: true });
    }
    return fontCache.unicode;
};

const getDrawableFont = async (
    pdfDocument: PDFDocument,
    fontCache: FontCache,
    fontName: StandardFonts,
    text: string,
) => {
    const standardFont = fontCache[fontName] ?? await pdfDocument.embedFont(fontName);
    fontCache[fontName] = standardFont;

    try {
        standardFont.encodeText(text);
        return standardFont;
    } catch {
        return getUnicodeFont(pdfDocument, fontCache);
    }
};

const dataUrlToBytes = async (dataUrl: string) => {
    const response = await fetch(dataUrl);
    if (!response.ok) {
        throw new Error('Could not read an embedded page image.');
    }
    return response.arrayBuffer();
};

const normalizeScaleX = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) return 1;
    return Math.max(0.05, Math.min(20, value));
};

const scaleTextToWidth = (
    font: PDFFont,
    text: string,
    size: number,
    targetWidth: number,
    fallbackScaleX: number,
) => {
    if (!text || !Number.isFinite(targetWidth) || targetWidth <= 0) {
        return normalizeScaleX(fallbackScaleX);
    }
    const measuredWidth = font.widthOfTextAtSize(text, size);
    if (!Number.isFinite(measuredWidth) || measuredWidth <= 0) {
        return normalizeScaleX(fallbackScaleX);
    }
    return normalizeScaleX(targetWidth / measuredWidth);
};

const getPageFontKey = (
    pdfPage: PDFPage,
    font: PDFFont,
    fontKeyCache: WeakMap<PDFFont, PDFName>,
) => {
    const cachedKey = fontKeyCache.get(font);
    if (cachedKey) return cachedKey;
    const fontKey = pdfPage.node.newFontDictionary(font.name, font.ref);
    fontKeyCache.set(font, fontKey);
    return fontKey;
};

interface DrawScaledTextOptions {
    x: number;
    y: number;
    size: number;
    rotation: number;
    scaleX: number;
    color: RgbColor;
    renderingMode?: number;
    strokeColor?: RgbColor;
    strokeWidth?: number;
    fontKeyCache: WeakMap<PDFFont, PDFName>;
}

const drawScaledText = (
    pdfPage: PDFPage,
    font: PDFFont,
    text: string,
    options: DrawScaledTextOptions,
) => {
    const requestedMode = Number.isInteger(options.renderingMode) ? options.renderingMode ?? 0 : 0;
    const fillVisible = [0, 2, 4, 6].includes(requestedMode);
    const strokeVisible = [1, 2, 5, 6].includes(requestedMode);
    const textRenderingMode = strokeVisible
        ? fillVisible
            ? TextRenderingMode.FillAndOutline
            : TextRenderingMode.Outline
        : TextRenderingMode.Fill;
    const fontKey = getPageFontKey(pdfPage, font, options.fontKeyCache);
    const operators: PDFOperator[] = [
        pushGraphicsState(),
        beginText(),
        setFillingColor(rgb(...normalizeColor(options.color))),
    ];

    if (strokeVisible) {
        operators.push(
            setStrokingColor(rgb(...normalizeColor(options.strokeColor ?? options.color))),
            setLineWidth(Math.max(0.25, options.strokeWidth ?? options.size * 0.045)),
        );
    }

    operators.push(
        setTextRenderingMode(textRenderingMode),
        setFontAndSize(fontKey, options.size),
        setCharacterSqueeze(normalizeScaleX(options.scaleX) * 100),
        rotateAndSkewTextDegreesAndTranslate(options.rotation, 0, 0, options.x, options.y),
        showText(font.encodeText(text)),
        endText(),
        popGraphicsState(),
    );
    pdfPage.pushOperators(...operators);
};

const applyTextEdit = async (
    pdfDocument: PDFDocument,
    pdfPage: PDFPage,
    block: TextContentBlock,
    fontCache: FontCache,
    fontKeyCache: WeakMap<PDFFont, PDFName>,
) => {
    const fontSize = Math.max(block.pdfFontSize, 1);
    const originalText = block.originalText ?? '';
    const replacementText = block.deleted ? '' : block.text ?? '';
    const originalFont = await getDrawableFont(
        pdfDocument,
        fontCache,
        pickStandardFont(block.fontInfo),
        originalText || replacementText,
    );
    const scaleX = scaleTextToWidth(
        originalFont,
        originalText,
        fontSize,
        block.origWidth,
        block.pdfTextScaleX,
    );

    if (originalText.trim()) {
        const padding = Math.max(0.25, DEFAULT_TEXT_COVER_PADDING / 1.5, fontSize * 0.018);
        drawScaledText(pdfPage, originalFont, originalText, {
            x: block.origPdfX,
            y: block.origPdfY,
            size: fontSize,
            rotation: block.pdfRotation,
            scaleX,
            color: block.backgroundColor,
            renderingMode: TextRenderingMode.FillAndOutline,
            strokeColor: block.backgroundColor,
            strokeWidth: padding,
            fontKeyCache,
        });
    }

    if (!replacementText.trim()) return;

    const replacementFont = await getDrawableFont(
        pdfDocument,
        fontCache,
        pickStandardFont(block.fontInfo),
        replacementText,
    );
    drawScaledText(pdfPage, replacementFont, replacementText, {
        x: block.pdfX,
        y: block.pdfY,
        size: fontSize,
        rotation: block.pdfRotation,
        scaleX,
        color: block.pdfColor,
        renderingMode: block.textEffects.renderingMode,
        strokeColor: block.textEffects.strokeColor,
        strokeWidth: block.textEffects.strokeWidth,
        fontKeyCache,
    });
};

export const applyContentEditsToPdfPage = async (
    pdfDocument: PDFDocument,
    pdfPage: PDFPage,
    edits: ContentEdit[],
) => {
    const dirtyEdits = edits.filter((edit) => edit.isDirty);
    if (dirtyEdits.length === 0) return;

    const fontCache: FontCache = {};
    const fontKeyCache = new WeakMap<PDFFont, PDFName>();

    for (const edit of dirtyEdits) {
        if (edit.type === 'text') {
            await applyTextEdit(pdfDocument, pdfPage, edit, fontCache, fontKeyCache);
            continue;
        }

        pdfPage.drawRectangle({
            x: edit.origPdfX,
            y: edit.origPdfY,
            width: edit.origWidth,
            height: edit.origHeight,
            color: rgb(...normalizeColor(edit.backgroundColor)),
            opacity: 1,
            rotate: degrees(edit.pdfRotation),
        });

        if (edit.deleted) continue;

        const image = await pdfDocument.embedPng(await dataUrlToBytes(edit.imageDataUrl));
        pdfPage.drawImage(image, {
            x: edit.pdfX,
            y: edit.pdfY,
            width: edit.pdfWidth,
            height: edit.pdfHeight,
            rotate: degrees(edit.pdfRotation),
        });
    }
};
