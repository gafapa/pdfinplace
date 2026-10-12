import type { Annotation } from '../types/annotations';
import type { ContentEdit } from '../features/content-editor/types';
import type { FormValues } from '../features/forms/formTypes';
import type { ImageCompressionResult } from '../features/export/compressImages';
import type { LoadedPdfDocument } from '../utils/pdfjs';
import type { ImageExportFormat } from '../utils/imageExport';

export interface EditorPage {
    id: string; // Unique ID for dnd (e.g., "fileId-pageIndex")
    fileId: string;
    pageIndex: number; // 1-based index in the source file
    rotation: number; // 0, 90, 180, 270
    annotations: Annotation[]; // Page annotations
    contentEdits: ContentEdit[];
    annotationCanvasWidth?: number;
    annotationCanvasHeight?: number;
    previewRevision?: number;
    /** Filled form values of the whole source file; every page of the file carries the same map. */
    formValues?: FormValues;
}

export interface EditorFile {
    id: string;
    file: File;
    pdfDoc?: import('pdfjs-dist').PDFDocumentProxy; // Cached pdf.js document for rendering
    loadingTask?: LoadedPdfDocument['loadingTask']; // Owning loading task, needed to fully release the document
    pageCount: number;
}

export type PageSize = 'Original' | 'A4' | 'A3' | 'Letter' | 'Legal';
export interface ExportLabels {
    failed: string;
    /** Download name when the pages come from several files. */
    downloadPrefix: string;
    /** Appended to the source file name, e.g. "invoice_edited.pdf". */
    editedSuffix?: string;
    missingPagesWarning?: string;
    success?: string;
    /** Explains why content edits on a page could not be saved. */
    contentEditFailed?: (pageNumber: number, code?: string) => string;
    /** Explains that a filled form field could not be written. */
    formFillFailed?: (fieldName: string) => string;
    /** Success message after an export that compressed images. */
    compressionResult?: (result: ImageCompressionResult) => string;
}

export interface ImportLabels {
    skippedPrefix: string;
    failedPrefix: string;
    fileCount: string;
    unsupported: string;
    fileSize: string;
    batchSize: string;
    pageLimit: string;
    imageTooLarge: string;
    unreadable: string;
    /** Appended to the success message when DOCX/ODT pages were imported as images. */
    officeRasterized?: string;
    success?: string;
    onPasswordRequired?: (file: File) => void;
}

export interface EditorNotification {
    id: string;
    message: string;
    tone: 'error' | 'success';
}

export interface SplitPdfLabels extends ExportLabels {
    splitDownloadPrefix: string;
    splitSuffix?: string;
    oddSuffix: string;
    evenSuffix: string;
    pageSuffix: string;
}

export interface ImageExportOptions {
    format: ImageExportFormat;
    quality: number;
}

export interface ImageExportLabels {
    failed: string;
    limitExceeded: string;
    missingPagesWarning?: string;
    pagePrefix: string;
    downloadPrefix: string;
    imagesSuffix?: string;
    success?: string;
    contentEditFailed?: (pageNumber: number, code?: string) => string;
    formFillFailed?: (fieldName: string) => string;
}

export interface PrintOverlayOptions {
    watermarkText: string;
    includePageNumbers: boolean;
    headerText: string;
    footerText: string;
    cropPercent: number;
    marginPercent: number;
}

export interface ProtectPdfLabels extends ExportLabels {
    invalidPassword: string;
    protectedSuffix?: string;
}

export interface UnlockPdfLabels {
    failed: string;
    invalidPassword: string;
    invalidFile: string;
}

