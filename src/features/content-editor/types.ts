export type RgbColor = [number, number, number];

export interface ContentFontInfo {
    bold: boolean;
    italic: boolean;
    family: 'sans' | 'serif' | 'mono';
    cssFamily: string;
    rawName: string;
}

interface ContentTextEffects {
    renderingMode: number;
    strokeColor: RgbColor;
    strokeWidth: number;
    screenStrokeWidth: number;
}

interface ContentBlockBase {
    id: string;
    pageIndex: number;
    x: number;
    y: number;
    origX: number;
    origY: number;
    width: number;
    height: number;
    pdfX: number;
    pdfY: number;
    origPdfX: number;
    origPdfY: number;
    origWidth: number;
    pdfRotation: number;
    screenRotation: number;
    backgroundColor: RgbColor;
    isDirty: boolean;
    deleted?: boolean;
}

export interface TextContentBlock extends ContentBlockBase {
    type: 'text';
    text: string;
    originalText: string;
    pdfFontSize: number;
    pdfTextScaleX: number;
    screenFontSize: number;
    screenTextScaleX: number;
    screenFontAscent: number;
    fontInfo: ContentFontInfo;
    pdfColor: RgbColor;
    textEffects: ContentTextEffects;
}

interface ImageContentBlock extends ContentBlockBase {
    type: 'image';
    origHeight: number;
    pdfWidth: number;
    pdfHeight: number;
    imageDataUrl: string;
}

export type ContentBlock = TextContentBlock | ImageContentBlock;

/**
 * Only dirty blocks are persisted. Screen coordinates are recalculated whenever
 * the source page is parsed so saved edits remain stable across viewport sizes.
 */
export type ContentEdit = ContentBlock;

export interface ParsedContentPage {
    viewportWidth: number;
    viewportHeight: number;
    viewportTransform: number[];
    blocks: ContentBlock[];
}
