import type { Annotation } from '../types/annotations';
import type { ContentEdit } from '../features/content-editor/types';
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
    downloadPrefix: string;
    originalName?: string;
    missingPagesWarning?: string;
    success?: string;
}

export interface ImportLabels {
    skippedPrefix: string;
    failedPrefix: string;
    fileCount: string;
    unsupported: string;
    fileSize: string;
    batchSize: string;
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
    success?: string;
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
}

export interface UnlockPdfLabels {
    failed: string;
    invalidPassword: string;
    invalidFile: string;
}

