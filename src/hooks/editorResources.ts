import type { PDFDocument, PDFFont } from 'pdf-lib';
import type { Annotation, ImageAnnotationData } from '../types/annotations';
import type { PageSize } from './editorTypes';
import type { LoadedPdfDocument } from '../utils/pdfjs';
import { PDFJS_RESOURCE_VERSION } from '../utils/pdfjsResourceVersion';
import { formatMegabytes, MAX_ARCHIVE_ENTRIES, MAX_ARCHIVE_ENTRY_BYTES, MAX_ARCHIVE_UNCOMPRESSED_BYTES, MAX_OFFICE_XML_ELEMENTS, MAX_RENDER_PIXELS } from '../utils/importValidation';

export type PdfLibModule = typeof import('pdf-lib');

export class ImportLimitError extends Error {}

export const releasePdfDocument = (fileData?: {
    pdfDoc?: import('pdfjs-dist').PDFDocumentProxy;
    loadingTask?: LoadedPdfDocument['loadingTask'];
}) => {
    if (!fileData) return;

    if (fileData.loadingTask) {
        void fileData.loadingTask.destroy().catch(() => {
            // The document transport may already be gone; nothing else to release.
        });
        return;
    }

    if (fileData.pdfDoc) {
        void Promise.resolve(fileData.pdfDoc.cleanup()).catch(() => {
            // Best-effort cleanup for documents loaded without a tracked task.
        });
    }
};

let pdfLibPromise: Promise<PdfLibModule> | null = null;
let contentEditExporterPromise: Promise<typeof import('../features/content-editor/applyContentEdits')> | null = null;
let unicodeFontBytesPromise: Promise<ArrayBuffer> | null = null;
export const overlayFontCache = new WeakMap<PDFDocument, Promise<PDFFont>>();
export const UNICODE_FONT_PATH = `${import.meta.env.BASE_URL}pdfjs/${PDFJS_RESOURCE_VERSION}/standard_fonts/LiberationSans-Regular.ttf`;

export const loadPdfLib = async (): Promise<PdfLibModule> => {
    if (!pdfLibPromise) {
        pdfLibPromise = import('pdf-lib');
    }
    return pdfLibPromise;
};

export const loadContentEditExporter = () => {
    if (!contentEditExporterPromise) {
        contentEditExporterPromise = import('../features/content-editor/applyContentEdits');
    }
    return contentEditExporterPromise;
};

export const loadUnicodeFontBytes = async () => {
    if (!unicodeFontBytesPromise) {
        unicodeFontBytesPromise = fetch(UNICODE_FONT_PATH).then((response) => {
            if (!response.ok) {
                throw new Error(`Could not load the Unicode fallback font (${response.status}).`);
            }
            return response.arrayBuffer();
        });
    }
    try {
        return await unicodeFontBytesPromise;
    } catch (error) {
        unicodeFontBytesPromise = null;
        throw error;
    }
};

export const getOverlayFont = (
    pdfDocument: PDFDocument,
    textValues: string[],
    pdfLib: PdfLibModule,
) => {
    const cached = overlayFontCache.get(pdfDocument);
    if (cached) return cached;

    const fontPromise = (async () => {
        const standardFont = await pdfDocument.embedFont(pdfLib.StandardFonts.Helvetica);
        try {
            textValues.forEach((value) => standardFont.encodeText(value));
            return standardFont;
        } catch {
            const { default: fontkit } = await import('@pdf-lib/fontkit');
            pdfDocument.registerFontkit(fontkit);
            return pdfDocument.embedFont(await loadUnicodeFontBytes(), { subset: true });
        }
    })();
    overlayFontCache.set(pdfDocument, fontPromise);
    return fontPromise;
};

export const PAGE_SIZES: Record<Exclude<PageSize, 'Original'>, [number, number]> = {
    A4: [595.28, 841.89],
    A3: [841.89, 1190.55],
    Letter: [612.00, 792.00],
    Legal: [612.00, 1008.00]
};

export const toArrayBuffer = (bytes: Uint8Array<ArrayBufferLike>): ArrayBuffer => {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return buffer;
};

export const cloneArrayBuffer = (buffer: ArrayBuffer) => buffer.slice(0);

export const isUsableArrayBuffer = (buffer: ArrayBuffer) => {
    try {
        return buffer.byteLength > 0;
    } catch {
        return false;
    }
};

export interface ArchiveEntryMetadata {
    dir: boolean;
    _data?: {
        uncompressedSize?: number;
    };
}

export const validateArchiveLimits = (files: Record<string, ArchiveEntryMetadata>) => {
    const entries = Object.values(files);
    if (entries.length > MAX_ARCHIVE_ENTRIES) {
        throw new Error(`Archive contains more than ${MAX_ARCHIVE_ENTRIES} entries.`);
    }

    let totalUncompressedBytes = 0;
    for (const entry of entries) {
        if (entry.dir) continue;
        const entryBytes = entry._data?.uncompressedSize;
        if (!Number.isFinite(entryBytes) || entryBytes === undefined || entryBytes < 0) {
            throw new Error('Archive entry size could not be verified.');
        }
        if (entryBytes > MAX_ARCHIVE_ENTRY_BYTES) {
            throw new Error(`Archive entry exceeds ${formatMegabytes(MAX_ARCHIVE_ENTRY_BYTES)}.`);
        }
        totalUncompressedBytes += entryBytes;
        if (totalUncompressedBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
            throw new Error(`Archive expands beyond ${formatMegabytes(MAX_ARCHIVE_UNCOMPRESSED_BYTES)}.`);
        }
    }
};

export const assertRenderableArea = (width: number, height: number) => {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error('Document produced invalid render dimensions.');
    }
    if (width * height > MAX_RENDER_PIXELS) {
        throw new Error(`Rendered document exceeds the ${MAX_RENDER_PIXELS.toLocaleString()} pixel limit.`);
    }
};

export const validateOfficeXmlComplexity = (xml: string) => {
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
        throw new Error('Office XML declarations and entities are not supported.');
    }
    let elementCount = 0;
    for (let index = 0; index < xml.length; index += 1) {
        if (xml[index] === '<' && !['/', '?', '!'].includes(xml[index + 1] ?? '')) {
            elementCount += 1;
            if (elementCount > MAX_OFFICE_XML_ELEMENTS) {
                throw new Error(`Office XML exceeds the ${MAX_OFFICE_XML_ELEMENTS.toLocaleString()} element limit.`);
            }
        }
    }
};

export const canvasToPngBytes = (canvas: HTMLCanvasElement): Promise<ArrayBuffer> =>
    new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) {
                reject(new Error('Canvas could not be encoded as PNG.'));
                return;
            }
            blob.arrayBuffer().then(resolve, reject);
        }, 'image/png');
    });

export const canvasToImageBlob = (
    canvas: HTMLCanvasElement,
    mimeType: string,
    quality: number,
): Promise<Blob> => new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
        if (!blob || blob.type !== mimeType) {
            reject(new Error('Canvas could not be encoded as ' + mimeType + '.'));
            return;
        }
        resolve(blob);
    }, mimeType, quality);
});

export const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

export const downloadPdfBytes = (pdfBytes: Uint8Array<ArrayBufferLike>, filename: string) => {
    const pdfBytesBuffer = new ArrayBuffer(pdfBytes.byteLength);
    new Uint8Array(pdfBytesBuffer).set(pdfBytes);
    downloadBlob(new Blob([pdfBytesBuffer], { type: 'application/pdf' }), filename);
};

export const MAX_IMAGE_EXPORT_TOTAL_PIXELS = 160_000_000;

export class ImageExportLimitError extends Error {}

export class ContentEditExportError extends Error {
    readonly pageNumber: number;
    readonly code?: string;

    constructor(pageNumber: number, reason: string, code?: string) {
        super(`Content edits on page ${pageNumber} could not be saved: ${reason}`);
        this.name = 'ContentEditExportError';
        this.pageNumber = pageNumber;
        this.code = code;
    }
}

export interface ExportFailureLabels {
    contentEditFailed?: (pageNumber: number, code?: string) => string;
    formFillFailed?: (fieldName: string) => string;
}

/** User-facing export failure; content edit and form failures say what failed. */
export const exportFailureMessage = (error: unknown, fallback: string, labels?: ExportFailureLabels) => {
    if (error instanceof ContentEditExportError && labels?.contentEditFailed) {
        return labels.contentEditFailed(error.pageNumber, error.code);
    }
    // Matched by name: the form module imports this file.
    if (error instanceof Error && error.name === 'FormFillError' && labels?.formFillFailed) {
        return labels.formFillFailed(String((error as Error & { fieldName?: unknown }).fieldName ?? ''));
    }
    return fallback;
};

export const getContentBox = (
    pageWidth: number,
    pageHeight: number,
    marginPercent: number,
) => {
    const marginX = (pageWidth * marginPercent) / 100;
    const marginY = (pageHeight * marginPercent) / 100;

    return {
        x: marginX,
        y: marginY,
        width: Math.max(1, pageWidth - (marginX * 2)),
        height: Math.max(1, pageHeight - (marginY * 2)),
    };
};

export const getCropZoom = (cropPercent: number) => {
    const visibleRatio = Math.max(0.2, 1 - ((cropPercent * 2) / 100));
    return 1 / visibleRatio;
};

export const isLikelyInvalidPasswordError = (error: unknown): boolean => {
    const content = error instanceof Error
        ? `${error.name} ${error.message}`.toLowerCase()
        : String(error).toLowerCase();

    return content.includes('password') ||
        content.includes('credential') ||
        content.includes('auth') ||
        content.includes('decrypt');
};


export const hexToRgb = (hex: string, rgbFactory: PdfLibModule['rgb']) => {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    return rgbFactory(r, g, b);
};

export const isImageLikeAnnotation = (annotation: Annotation): annotation is Annotation & {
    type: 'image' | 'signature';
    data: ImageAnnotationData | { dataUrl: string };
} => annotation.type === 'image' || annotation.type === 'signature';

