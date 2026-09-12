import { useState, useCallback, useEffect, useRef } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import type {
    Annotation,
    TextAnnotationData,
    DrawingAnnotationData,
    ShapeAnnotationData,
    ImageAnnotationData
} from '../types/annotations';
import type { PDFDocument, PDFFont, PDFPage } from 'pdf-lib';
import { createId } from '../utils/createId';
import { clearPersistedSession, loadPersistedSession, savePersistedSession, type PersistedFileRecord } from '../utils/persistedSession';
import { loadPdfDocumentWithTask, type LoadedPdfDocument } from '../utils/pdfjs';
import {
    MAX_ARCHIVE_ENTRIES,
    MAX_ARCHIVE_ENTRY_BYTES,
    MAX_ARCHIVE_UNCOMPRESSED_BYTES,
    MAX_IMAGE_PIXELS,
    MAX_IMPORT_FILES,
    MAX_IMPORT_PAGES,
    MAX_IMPORT_TOTAL_SIZE_BYTES,
    MAX_OFFICE_XML_ELEMENTS,
    MAX_RENDER_PIXELS,
    formatMegabytes,
    getAcceptedImportFiles,
    getImportFileKind,
    isAcceptedUnlockPdf,
} from '../utils/importValidation';
import { getDataUrlImageKind, readImageDimensions } from '../utils/imageValidation';
import { getLegacyEditorCanvasSize } from '../utils/pageGeometry';
import type { ContentEdit } from '../features/content-editor/types';
import { clearPersistedAssets } from '../utils/persistedAssets';
import { orderItemsByIds } from '../utils/orderedSelection';
import {
    getImageExportFilename,
    getImageExportFormatDetails,
    getImageExportRenderScale,
    normalizeImageExportQuality,
    type ImageExportFormat,
} from '../utils/imageExport';
import {
    getSessionPersistencePreference,
    setSessionPersistencePreference,
    subscribeToSessionPreference,
} from '../utils/sessionPreference';

type PdfLibModule = typeof import('pdf-lib');

class ImportLimitError extends Error {}

const releasePdfDocument = (fileData?: {
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
const overlayFontCache = new WeakMap<PDFDocument, Promise<PDFFont>>();
const UNICODE_FONT_PATH = `${import.meta.env.BASE_URL}pdfjs/standard_fonts/LiberationSans-Regular.ttf`;

const loadPdfLib = async (): Promise<PdfLibModule> => {
    if (!pdfLibPromise) {
        pdfLibPromise = import('pdf-lib');
    }
    return pdfLibPromise;
};

const loadContentEditExporter = () => {
    if (!contentEditExporterPromise) {
        contentEditExporterPromise = import('../features/content-editor/applyContentEdits');
    }
    return contentEditExporterPromise;
};

const loadUnicodeFontBytes = async () => {
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

const getOverlayFont = (
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
interface ExportLabels {
    failed: string;
    downloadPrefix: string;
    originalName?: string;
    missingPagesWarning?: string;
    success?: string;
}

interface ImportLabels {
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

interface SplitPdfLabels extends ExportLabels {
    splitDownloadPrefix: string;
    oddSuffix: string;
    evenSuffix: string;
    pageSuffix: string;
}

export interface ImageExportOptions {
    format: ImageExportFormat;
    quality: number;
}

interface ImageExportLabels {
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

interface ProtectPdfLabels extends ExportLabels {
    invalidPassword: string;
}

interface UnlockPdfLabels {
    failed: string;
    invalidPassword: string;
    invalidFile: string;
}

const PAGE_SIZES: Record<Exclude<PageSize, 'Original'>, [number, number]> = {
    A4: [595.28, 841.89],
    A3: [841.89, 1190.55],
    Letter: [612.00, 792.00],
    Legal: [612.00, 1008.00]
};

const toArrayBuffer = (bytes: Uint8Array<ArrayBufferLike>): ArrayBuffer => {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return buffer;
};

const cloneArrayBuffer = (buffer: ArrayBuffer) => buffer.slice(0);

const isUsableArrayBuffer = (buffer: ArrayBuffer) => {
    try {
        return buffer.byteLength > 0;
    } catch {
        return false;
    }
};

interface ArchiveEntryMetadata {
    dir: boolean;
    _data?: {
        uncompressedSize?: number;
    };
}

const validateArchiveLimits = (files: Record<string, ArchiveEntryMetadata>) => {
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

const assertRenderableArea = (width: number, height: number) => {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error('Document produced invalid render dimensions.');
    }
    if (width * height > MAX_RENDER_PIXELS) {
        throw new Error(`Rendered document exceeds the ${MAX_RENDER_PIXELS.toLocaleString()} pixel limit.`);
    }
};

const validateOfficeXmlComplexity = (xml: string) => {
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

const canvasToPngBytes = (canvas: HTMLCanvasElement): Promise<ArrayBuffer> =>
    new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) {
                reject(new Error('Canvas could not be encoded as PNG.'));
                return;
            }
            blob.arrayBuffer().then(resolve, reject);
        }, 'image/png');
    });

const canvasToImageBlob = (
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

const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

const downloadPdfBytes = (pdfBytes: Uint8Array<ArrayBufferLike>, filename: string) => {
    const pdfBytesBuffer = new ArrayBuffer(pdfBytes.byteLength);
    new Uint8Array(pdfBytesBuffer).set(pdfBytes);
    downloadBlob(new Blob([pdfBytesBuffer], { type: 'application/pdf' }), filename);
};

const LEGACY_EXPORT_HISTORY_STORAGE_KEY = 'pageforge.export-history';
const OVERLAY_OPTIONS_STORAGE_KEY = 'pageforge.overlay-options';
const SAVED_ASSETS_STORAGE_KEY = 'pageforge.saved-assets';
const MAX_HISTORY_ENTRIES = 80;
const SESSION_PERSIST_DEBOUNCE_MS = 600;
const MAX_IMAGE_EXPORT_TOTAL_PIXELS = 160_000_000;

class ImageExportLimitError extends Error {}

const clearSensitiveBrowserData = async () => {
    if (typeof window !== 'undefined') {
        localStorage.removeItem(LEGACY_EXPORT_HISTORY_STORAGE_KEY);
        localStorage.removeItem(SAVED_ASSETS_STORAGE_KEY);
        localStorage.removeItem(OVERLAY_OPTIONS_STORAGE_KEY);
    }

    const clearResults = await Promise.allSettled([
        clearPersistedSession(),
        clearPersistedAssets(),
    ]);
    clearResults.forEach((result) => {
        if (result.status === 'rejected') {
            console.error('Failed to clear sensitive browser data:', result.reason);
        }
    });
};

const DEFAULT_PRINT_OVERLAY_OPTIONS: PrintOverlayOptions = {
    watermarkText: '',
    includePageNumbers: false,
    headerText: '',
    footerText: '',
    cropPercent: 0,
    marginPercent: 0,
};

const loadOverlayOptions = (): PrintOverlayOptions => {
    if (typeof window === 'undefined' || !getSessionPersistencePreference()) {
        if (typeof window !== 'undefined') {
            localStorage.removeItem(OVERLAY_OPTIONS_STORAGE_KEY);
        }
        return DEFAULT_PRINT_OVERLAY_OPTIONS;
    }

    try {
        const rawOptions = localStorage.getItem(OVERLAY_OPTIONS_STORAGE_KEY);
        if (!rawOptions) {
            return DEFAULT_PRINT_OVERLAY_OPTIONS;
        }

        const parsedOptions = JSON.parse(rawOptions) as Partial<PrintOverlayOptions>;
        return {
            watermarkText: typeof parsedOptions.watermarkText === 'string' ? parsedOptions.watermarkText : '',
            includePageNumbers: Boolean(parsedOptions.includePageNumbers),
            headerText: typeof parsedOptions.headerText === 'string' ? parsedOptions.headerText : '',
            footerText: typeof parsedOptions.footerText === 'string' ? parsedOptions.footerText : '',
            cropPercent: typeof parsedOptions.cropPercent === 'number' ? Math.max(0, Math.min(parsedOptions.cropPercent, 20)) : 0,
            marginPercent: typeof parsedOptions.marginPercent === 'number' ? Math.max(0, Math.min(parsedOptions.marginPercent, 20)) : 0,
        };
    } catch (error) {
        console.error('Failed to read overlay options:', error);
        return DEFAULT_PRINT_OVERLAY_OPTIONS;
    }
};

const getContentBox = (
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

const getCropZoom = (cropPercent: number) => {
    const visibleRatio = Math.max(0.2, 1 - ((cropPercent * 2) / 100));
    return 1 / visibleRatio;
};

const isLikelyInvalidPasswordError = (error: unknown): boolean => {
    const content = error instanceof Error
        ? `${error.name} ${error.message}`.toLowerCase()
        : String(error).toLowerCase();

    return content.includes('password') ||
        content.includes('credential') ||
        content.includes('auth') ||
        content.includes('decrypt');
};


// Custom hook for history management
const useHistory = <T>(initialState: T) => {
    const [historyState, setHistoryState] = useState<{ history: T[]; currentIndex: number }>({
        history: [initialState],
        currentIndex: 0
    });

    const state = historyState.history[historyState.currentIndex];

    const setState = useCallback((newState: T | ((prev: T) => T)) => {
        setHistoryState(prev => {
            const current = prev.history[prev.currentIndex];
            const updated = typeof newState === 'function'
                ? (newState as (prev: T) => T)(current)
                : newState;

            const truncatedHistory = prev.history.slice(0, prev.currentIndex + 1);
            const nextHistory = [...truncatedHistory, updated].slice(-MAX_HISTORY_ENTRIES);
            return {
                history: nextHistory,
                currentIndex: nextHistory.length - 1
            };
        });
    }, []);

    const undo = useCallback(() => {
        setHistoryState(prev => ({
            ...prev,
            currentIndex: Math.max(0, prev.currentIndex - 1)
        }));
    }, []);

    const redo = useCallback(() => {
        setHistoryState(prev => ({
            ...prev,
            currentIndex: Math.min(prev.history.length - 1, prev.currentIndex + 1)
        }));
    }, []);

    const setHistory = useCallback((nextHistory: T[]) => {
        setHistoryState(prev => ({ ...prev, history: nextHistory }));
    }, []);

    const setCurrentIndex = useCallback((nextIndex: number) => {
        setHistoryState(prev => ({ ...prev, currentIndex: nextIndex }));
    }, []);

    const canUndo = historyState.currentIndex > 0;
    const canRedo = historyState.currentIndex < historyState.history.length - 1;

    return {
        state,
        setState,
        undo,
        redo,
        canUndo,
        canRedo,
        history: historyState.history,
        setHistory,
        setCurrentIndex
    };
};

const hexToRgb = (hex: string, rgbFactory: PdfLibModule['rgb']) => {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    return rgbFactory(r, g, b);
};

const isImageLikeAnnotation = (annotation: Annotation): annotation is Annotation & {
    type: 'image' | 'signature';
    data: ImageAnnotationData | { dataUrl: string };
} => annotation.type === 'image' || annotation.type === 'signature';

const getInitialPageSize = (): PageSize => {
    if (typeof window === 'undefined') {
        return 'Original';
    }

    const savedPageSize = localStorage.getItem('pageforge.editor.page-size');
    return savedPageSize === 'A4' || savedPageSize === 'A3' || savedPageSize === 'Letter' || savedPageSize === 'Legal'
        ? savedPageSize
        : 'Original';
};

export const usePdfEditor = () => {
    const [files, setFiles] = useState<Record<string, EditorFile>>({});
    // Use history for pages
    const {
        state: pages,
        setState: setPages,
        undo,
        redo,
        canUndo,
        canRedo,
        history: pagesHistory,
        setHistory: setPagesHistory,
        setCurrentIndex: setPagesCurrentIndex
    } = useHistory<EditorPage[]>([]);

    const [isProcessing, setIsProcessing] = useState(false);
    const [notification, setNotification] = useState<EditorNotification | null>(null);
    const [pageSize, setPageSize] = useState<PageSize>(getInitialPageSize);
    const [isSessionReady, setIsSessionReady] = useState(false);
    const [hasSavedSession, setHasSavedSession] = useState(false);
    const [isSessionPersistenceEnabled, setIsSessionPersistenceEnabled] = useState(getSessionPersistencePreference);
    const persistedFileCacheRef = useRef<Record<string, PersistedFileRecord>>({});
    const filesRef = useRef<Record<string, EditorFile>>({});
    const isImportingRef = useRef(false);
    const [printOverlayOptions, setPrintOverlayOptions] = useState<PrintOverlayOptions>(loadOverlayOptions);
    const notifyError = useCallback((message: string) => {
        setNotification({ id: createId(), message, tone: 'error' });
    }, []);
    const notifySuccess = useCallback((message: string) => {
        setNotification({ id: createId(), message, tone: 'success' });
    }, []);
    const dismissNotification = useCallback(() => setNotification(null), []);

    const applySessionPersistencePreference = useCallback((enabled: boolean) => {
        setIsSessionPersistenceEnabled(enabled);

        if (!enabled) {
            persistedFileCacheRef.current = {};
            setHasSavedSession(false);
            setPrintOverlayOptions(DEFAULT_PRINT_OVERLAY_OPTIONS);
            void clearSensitiveBrowserData();
        }
    }, []);

    const setSessionPersistenceEnabled = useCallback((enabled: boolean) => {
        setSessionPersistencePreference(enabled);
    }, []);

    useEffect(() => subscribeToSessionPreference(applySessionPersistencePreference), [applySessionPersistencePreference]);

    useEffect(() => {
        localStorage.removeItem(LEGACY_EXPORT_HISTORY_STORAGE_KEY);
    }, []);

    useEffect(() => {
        let isCancelled = false;

        const restoreSession = async () => {
            if (!isSessionPersistenceEnabled) {
                persistedFileCacheRef.current = {};
                await clearSensitiveBrowserData();
                if (!isCancelled) {
                    setHasSavedSession(false);
                    setIsSessionReady(true);
                }
                return;
            }

            try {
                const persistedSession = await loadPersistedSession();
                if (isCancelled || !persistedSession) {
                    if (!isCancelled) {
                        persistedFileCacheRef.current = {};
                        setIsSessionReady(true);
                        setHasSavedSession(Boolean(persistedSession));
                    }
                    return;
                }

                const persistedBytes = persistedSession.files.reduce(
                    (total, persistedFile) => total + persistedFile.buffer.byteLength,
                    0,
                );
                if (
                    persistedSession.files.length > MAX_IMPORT_FILES ||
                    persistedSession.pages.length > MAX_IMPORT_PAGES ||
                    persistedBytes > MAX_IMPORT_TOTAL_SIZE_BYTES
                ) {
                    throw new Error('The saved session exceeds the current safety limits.');
                }

                persistedFileCacheRef.current = Object.fromEntries(
                    persistedSession.files.map((persistedFile) => [persistedFile.id, persistedFile])
                );

                const restoredFiles: (readonly [string, EditorFile])[] = [];
                let restoreFailure: unknown = null;
                let restoreCancelled = false;

                for (const persistedFile of persistedSession.files) {
                    if (isCancelled) {
                        restoreCancelled = true;
                        break;
                    }
                    try {
                        const file = new File([cloneArrayBuffer(persistedFile.buffer)], persistedFile.name, {
                            type: persistedFile.type,
                            lastModified: persistedFile.lastModified,
                        });
                        const { pdfDoc, loadingTask } = await loadPdfDocumentWithTask({ data: cloneArrayBuffer(persistedFile.buffer) });

                        restoredFiles.push([persistedFile.id, {
                            id: persistedFile.id,
                            file,
                            pageCount: persistedFile.pageCount,
                            pdfDoc,
                            loadingTask,
                        }]);
                    } catch (loadError) {
                        restoreFailure = loadError;
                        break;
                    }
                }

                if (restoreFailure !== null || restoreCancelled || isCancelled) {
                    restoredFiles.forEach(([, fileData]) => releasePdfDocument(fileData));
                }
                if (restoreFailure !== null) {
                    throw restoreFailure;
                }
                if (restoreCancelled || isCancelled) {
                    return;
                }

                setFiles(Object.fromEntries(restoredFiles));
                setPagesHistory([persistedSession.pages.map((page) => ({
                    ...page,
                    contentEdits: page.contentEdits ?? [],
                }))]);
                setPagesCurrentIndex(0);
                setPageSize(persistedSession.pageSize);
                setHasSavedSession(true);
            } catch (error) {
                console.error('Failed to restore session:', error);
                persistedFileCacheRef.current = {};
                await clearPersistedSession();
                if (!isCancelled) setHasSavedSession(false);
            } finally {
                if (!isCancelled) {
                    setIsSessionReady(true);
                }
            }
        };

        void restoreSession();

        return () => {
            isCancelled = true;
        };
    }, [isSessionPersistenceEnabled, setPagesCurrentIndex, setPagesHistory]);

    useEffect(() => {
        if (!isSessionReady) {
            return;
        }

        const persistSession = async () => {
            if (pages.length === 0 || Object.keys(files).length === 0) {
                persistedFileCacheRef.current = {};
                await clearPersistedSession();
                setHasSavedSession(false);
                return;
            }

            if (!isSessionPersistenceEnabled) {
                persistedFileCacheRef.current = {};
                await clearSensitiveBrowserData();
                setHasSavedSession(false);
                return;
            }

            try {
                const nextFileCache: Record<string, PersistedFileRecord> = {};
                const referencedFileIds = new Set(pages.map((page) => page.fileId));
                const persistedFiles = await Promise.all(
                    Object.values(files).filter((fileData) => referencedFileIds.has(fileData.id)).map(async (fileData) => {
                        const cachedFile = persistedFileCacheRef.current[fileData.id];
                        const canReuseCachedFile = cachedFile &&
                            isUsableArrayBuffer(cachedFile.buffer) &&
                            cachedFile.name === fileData.file.name &&
                            cachedFile.type === fileData.file.type &&
                            cachedFile.lastModified === fileData.file.lastModified &&
                            cachedFile.pageCount === fileData.pageCount;

                        const persistedFile = canReuseCachedFile
                            ? cachedFile
                            : {
                                id: fileData.id,
                                name: fileData.file.name,
                                type: fileData.file.type,
                                lastModified: fileData.file.lastModified,
                                pageCount: fileData.pageCount,
                                buffer: await fileData.file.arrayBuffer(),
                            };

                        nextFileCache[fileData.id] = persistedFile;
                        return persistedFile;
                    })
                );

                persistedFileCacheRef.current = nextFileCache;
                await savePersistedSession({
                    files: persistedFiles,
                    pages,
                    pageSize,
                    savedAt: Date.now(),
                });
                setHasSavedSession(true);
            } catch (error) {
                console.error('Failed to persist session:', error);
            }
        };

        const timeoutId = window.setTimeout(() => {
            void persistSession();
        }, SESSION_PERSIST_DEBOUNCE_MS);

        return () => window.clearTimeout(timeoutId);
    }, [files, pages, pageSize, isSessionReady, isSessionPersistenceEnabled]);

    useEffect(() => {
        if (isSessionPersistenceEnabled) {
            localStorage.setItem(OVERLAY_OPTIONS_STORAGE_KEY, JSON.stringify(printOverlayOptions));
        } else {
            localStorage.removeItem(OVERLAY_OPTIONS_STORAGE_KEY);
        }
    }, [printOverlayOptions, isSessionPersistenceEnabled]);

    useEffect(() => {
        filesRef.current = files;
    }, [files]);

    useEffect(() => {
        const referencedFileIds = new Set(
            pagesHistory.flatMap((historyPages) => historyPages.map((page) => page.fileId)),
        );
        const obsoleteFiles = Object.values(files).filter(
            (fileData) => !referencedFileIds.has(fileData.id),
        );
        if (obsoleteFiles.length === 0) return;

        const cleanupId = window.setTimeout(() => {
            obsoleteFiles.forEach((fileData) => {
                releasePdfDocument(fileData.pdfDoc);
                delete persistedFileCacheRef.current[fileData.id];
            });
            setFiles((currentFiles) => Object.fromEntries(
                Object.entries(currentFiles).filter(([fileId]) => referencedFileIds.has(fileId)),
            ));
        }, 0);
        return () => window.clearTimeout(cleanupId);
    }, [files, pagesHistory]);

    useEffect(() => () => {
        Object.values(filesRef.current).forEach((fileData) => {
            releasePdfDocument(fileData.pdfDoc);
        });
    }, []);

    const addFiles = useCallback(async (newFiles: File[], labels: ImportLabels) => {
        if (isImportingRef.current) return;

        const existingFiles = Object.values(filesRef.current);
        const existingBytes = existingFiles.reduce((total, fileData) => total + fileData.file.size, 0);
        const { acceptedFiles, skippedReasons } = getAcceptedImportFiles(
            newFiles,
            existingFiles.length,
            existingBytes,
        );

        if (skippedReasons.length > 0) {
            const formattedReasons = skippedReasons.map((reason) => {
                const label = reason.code === 'file-count'
                    ? labels.fileCount
                    : reason.code === 'unsupported'
                        ? labels.unsupported
                        : reason.code === 'file-size'
                            ? labels.fileSize
                            : labels.batchSize;
                return reason.fileName ? `${reason.fileName}: ${label}` : label;
            });
            notifyError(`${labels.skippedPrefix}\n${formattedReasons.join('\n')}`);
        }

        if (acceptedFiles.length === 0) {
            return;
        }

        isImportingRef.current = true;
        setIsProcessing(true);
        try {
            const newFilesMap: Record<string, EditorFile> = {};
            const newPages: EditorPage[] = [];
            const failedReasons: string[] = [];
            const passwordProtectedFiles: File[] = [];
            const pdfLib = await loadPdfLib();
            let importedPageCount = pages.length;
            let importedFileBytes = existingBytes;

            const storeImportedFile = (fileId: string, fileData: EditorFile) => {
                if (existingFiles.length + Object.keys(newFilesMap).length >= MAX_IMPORT_FILES) {
                    releasePdfDocument(fileData.pdfDoc);
                    throw new ImportLimitError(labels.fileCount);
                }
                if (importedFileBytes + fileData.file.size > MAX_IMPORT_TOTAL_SIZE_BYTES) {
                    releasePdfDocument(fileData.pdfDoc);
                    throw new ImportLimitError(labels.batchSize);
                }

                newFilesMap[fileId] = fileData;
                importedFileBytes += fileData.file.size;
            };

            const appendFilePages = (fileId: string, pageCount: number) => {
                if (importedPageCount + pageCount > MAX_IMPORT_PAGES) {
                    throw new Error(`Import would exceed the ${MAX_IMPORT_PAGES} page limit.`);
                }

                for (let i = 1; i <= pageCount; i++) {
                    newPages.push({
                        id: `${fileId}-${i}-${createId().slice(0, 8)}`,
                        fileId,
                        pageIndex: i,
                        rotation: 0,
                        annotations: [],
                        contentEdits: [],
                    });
                }
                importedPageCount += pageCount;
            };

            for (const file of acceptedFiles) {
            const fileId = createId();
            try {
                let arrayBuffer = await file.arrayBuffer();
                const fileKind = getImportFileKind(file);

                // If image, convert to PDF first
                if (fileKind === 'jpeg' || fileKind === 'png') {
                    const imageDimensions = readImageDimensions(arrayBuffer);
                    if (!imageDimensions || imageDimensions.kind !== fileKind) {
                        throw new Error('Image contents do not match a supported PNG or JPEG file.');
                    }
                    if (imageDimensions.width * imageDimensions.height > MAX_IMAGE_PIXELS) {
                        throw new Error(`Image exceeds the ${MAX_IMAGE_PIXELS.toLocaleString()} pixel limit.`);
                    }

                    const pdfDoc = await pdfLib.PDFDocument.create();
                    let image;
                    if (fileKind === 'jpeg') {
                        image = await pdfDoc.embedJpg(arrayBuffer);
                    } else {
                        image = await pdfDoc.embedPng(arrayBuffer);
                    }

                    const page = pdfDoc.addPage([image.width, image.height]);
                    page.drawImage(image, {
                        x: 0,
                        y: 0,
                        width: image.width,
                        height: image.height,
                    });

                    const pdfBytes = await pdfDoc.save();
                    arrayBuffer = toArrayBuffer(pdfBytes);

                    const newFileName = file.name.replace(/\.(jpg|jpeg|png)$/i, '.pdf');
                    const newFile = new File([arrayBuffer], newFileName, { type: 'application/pdf' });

                    storeImportedFile(fileId, {
                        id: fileId,
                        file: newFile,
                        ...await loadPdfDocumentWithTask({ data: cloneArrayBuffer(arrayBuffer) }),
                        pageCount: 1
                    });

                    appendFilePages(fileId, 1);
                    continue;
                }

                // DOCX Handling
                if (fileKind === 'docx') {
                    const JSZip = (await import('jszip')).default;
                    const docxPreview = await import('docx-preview');
                    const html2canvas = (await import('html2canvas')).default;
                    const archive = await JSZip.loadAsync(arrayBuffer);
                    validateArchiveLimits(archive.files as Record<string, ArchiveEntryMetadata>);
                    const documentXml = await archive.file('word/document.xml')?.async('string');
                    if (!documentXml) {
                        throw new Error('DOCX document.xml is missing.');
                    }
                    validateOfficeXmlComplexity(documentXml);

                    // A4 dimensions at 96 DPI
                    const pageWidthPx = 794;
                    const pageHeightPx = 1123;

                    const container = document.createElement('div');
                    container.style.width = `${pageWidthPx}px`;
                    container.style.backgroundColor = 'white';
                    container.style.position = 'fixed';
                    container.style.left = '0';
                    container.style.top = '0';
                    container.style.zIndex = '-9999';
                    container.style.overflow = 'visible';
                    let canvas: HTMLCanvasElement;
                    try {
                        document.body.appendChild(container);

                        await docxPreview.renderAsync(arrayBuffer, container, undefined, {
                            className: 'docx-preview',
                            inWrapper: false,
                            ignoreWidth: false,
                            ignoreHeight: false,
                            ignoreFonts: false,
                            breakPages: true,
                            ignoreLastRenderedPageBreak: false,
                            experimental: true,
                            trimXmlDeclaration: true,
                            useBase64URL: true
                        });

                        await new Promise(r => setTimeout(r, 500));

                        const renderHeight = Math.max(container.scrollHeight, container.offsetHeight);
                        assertRenderableArea(pageWidthPx, renderHeight);
                        const estimatedPages = Math.max(1, Math.ceil(renderHeight / (pageHeightPx - 120)));
                        if (importedPageCount + estimatedPages > MAX_IMPORT_PAGES) {
                            throw new Error(`Import would exceed the ${MAX_IMPORT_PAGES} page limit.`);
                        }

                        canvas = await html2canvas(container, {
                            scale: 1,
                            useCORS: true,
                            logging: false,
                            width: pageWidthPx,
                            windowWidth: pageWidthPx,
                            scrollY: -window.scrollY
                        });
                    } finally {
                        container.remove();
                    }

                    assertRenderableArea(canvas.width, canvas.height);

                    // Create PDF with pdf-lib
                    const pdfDoc = await pdfLib.PDFDocument.create();

                    // A4 size in points (72 DPI)
                    const pageWidthPt = 595.28;
                    const pageHeightPt = 841.89;

                    // Margins in pixels (for content area)
                    const marginTopPx = 60;
                    const marginBottomPx = 60;
                    const contentHeightPx = pageHeightPx - marginTopPx - marginBottomPx;

                    // Helper function to find the "whitest" row near a target Y position
                    const findOptimalBreakPoint = (targetY: number, searchRange: number = 80): number => {
                        const tempCanvas = document.createElement('canvas');
                        tempCanvas.width = pageWidthPx;
                        tempCanvas.height = searchRange * 2;
                        const tempCtx = tempCanvas.getContext('2d');

                        if (!tempCtx) return targetY;

                        const startY = Math.max(0, targetY - searchRange);
                        const endY = Math.min(canvas.height, targetY + searchRange);
                        const actualHeight = endY - startY;

                        tempCtx.drawImage(canvas, 0, startY, pageWidthPx, actualHeight, 0, 0, pageWidthPx, actualHeight);
                        const imageData = tempCtx.getImageData(0, 0, pageWidthPx, actualHeight);
                        const data = imageData.data;

                        let bestY = targetY;
                        let bestWhiteness = -1;

                        // Scan each row to find the whitest one
                        for (let y = 0; y < actualHeight; y++) {
                            let rowWhiteness = 0;
                            for (let x = 0; x < pageWidthPx; x++) {
                                const i = (y * pageWidthPx + x) * 4;
                                // Calculate how "white" this pixel is (R+G+B close to 255 each)
                                const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
                                rowWhiteness += brightness;
                            }
                            rowWhiteness /= pageWidthPx;

                            // Prefer rows closer to the target, but prioritize whiteness
                            const distancePenalty = Math.abs(y - searchRange) * 0.1;
                            const score = rowWhiteness - distancePenalty;

                            if (score > bestWhiteness) {
                                bestWhiteness = score;
                                bestY = startY + y;
                            }
                        }

                        return bestY;
                    };

                    // Calculate break points with smart detection
                    const breakPoints: number[] = [0];
                    let currentY = 0;

                    while (currentY + contentHeightPx < canvas.height) {
                        const idealBreak = currentY + contentHeightPx;
                        const optimalBreak = findOptimalBreakPoint(idealBreak);
                        breakPoints.push(optimalBreak);
                        currentY = optimalBreak;
                    }
                    breakPoints.push(canvas.height);

                    const numPages = breakPoints.length - 1;

                    for (let p = 0; p < numPages; p++) {
                        const sliceCanvas = document.createElement('canvas');
                        sliceCanvas.width = pageWidthPx;
                        sliceCanvas.height = pageHeightPx;
                        const ctx = sliceCanvas.getContext('2d');

                        if (ctx) {
                            ctx.fillStyle = 'white';
                            ctx.fillRect(0, 0, pageWidthPx, pageHeightPx);

                            const sourceY = breakPoints[p];
                            const sourceHeight = Math.min(contentHeightPx, breakPoints[p + 1] - sourceY);

                            // Draw with top margin offset
                            ctx.drawImage(
                                canvas,
                                0, sourceY, pageWidthPx, sourceHeight,
                                0, marginTopPx, pageWidthPx, sourceHeight
                            );
                        }

                        const sliceBytes = await canvasToPngBytes(sliceCanvas);
                        const sliceImage = await pdfDoc.embedPng(sliceBytes);

                        const page = pdfDoc.addPage([pageWidthPt, pageHeightPt]);
                        page.drawImage(sliceImage, {
                            x: 0,
                            y: 0,
                            width: pageWidthPt,
                            height: pageHeightPt,
                        });
                    }

                    const pdfBytes = await pdfDoc.save();
                    arrayBuffer = toArrayBuffer(pdfBytes);

                    const newFileName = file.name.replace(/\.docx$/i, '.pdf');
                    const newFile = new File([arrayBuffer], newFileName, { type: 'application/pdf' });

                    const { pdfDoc: docxPdf, loadingTask: docxTask } = await loadPdfDocumentWithTask({ data: cloneArrayBuffer(arrayBuffer) });

                    storeImportedFile(fileId, {
                        id: fileId,
                        file: newFile,
                        pdfDoc: docxPdf,
                        loadingTask: docxTask,
                        pageCount: docxPdf.numPages
                    });

                    appendFilePages(fileId, docxPdf.numPages);
                    continue;
                }

                // ODT Handling
                if (fileKind === 'odt') {
                    const JSZip = (await import('jszip')).default;
                    const html2canvas = (await import('html2canvas')).default;

                    const zip = await JSZip.loadAsync(arrayBuffer);
                    validateArchiveLimits(zip.files as Record<string, ArchiveEntryMetadata>);
                    const contentXml = await zip.file("content.xml")?.async("string");

                    if (contentXml) {
                        validateOfficeXmlComplexity(contentXml);
                        const parser = new DOMParser();
                        const xmlDoc = parser.parseFromString(contentXml, "text/xml");

                        const appendExtractedText = (target: HTMLElement, node: Node) => {
                            const stack = Array.from(node.childNodes).reverse();
                            while (stack.length > 0) {
                                const child = stack.pop();
                                if (!child) continue;
                                if (child.nodeType === Node.TEXT_NODE) {
                                    target.appendChild(document.createTextNode(child.textContent ?? ''));
                                } else if (child.nodeName.endsWith(':s')) {
                                    target.appendChild(document.createTextNode(' '));
                                } else if (child.nodeName.endsWith(':tab')) {
                                    target.appendChild(document.createTextNode('\t'));
                                } else if (child.nodeName.endsWith(':line-break')) {
                                    target.appendChild(document.createElement('br'));
                                } else {
                                    stack.push(...Array.from(child.childNodes).reverse());
                                }
                            }
                        };

                        const processNode = (parent: HTMLElement, root: Element): boolean => {
                            const stack: Element[] = [root];
                            let appended = false;
                            while (stack.length > 0) {
                                const node = stack.pop();
                                if (!node) continue;
                                const name = node.nodeName;
                                if (name.endsWith(':h')) {
                                    const level = node.getAttributeNS("*", "outline-level") || '1';
                                    const hLevel = parseInt(level) || 1;
                                    const heading = document.createElement(`h${Math.min(6, Math.max(1, hLevel))}`);
                                    appendExtractedText(heading, node);
                                    parent.appendChild(heading);
                                    appended = true;
                                    continue;
                                }
                                if (name.endsWith(':p')) {
                                    const paragraph = document.createElement('p');
                                    appendExtractedText(paragraph, node);
                                    parent.appendChild(paragraph);
                                    appended = true;
                                    continue;
                                }
                                stack.push(...Array.from(node.children).reverse());
                            }
                            return appended;
                        };

                        // A4 dimensions at 96 DPI
                        const pageWidthPx = 794;
                        const pageHeightPx = 1123;
                        const marginPx = 40;
                        const contentWidthPx = pageWidthPx - (marginPx * 2);

                        // Create a visible container sized to A4 width
                        const container = document.createElement('div');
                        container.style.width = `${contentWidthPx}px`;
                        container.style.backgroundColor = 'white';
                        container.style.position = 'fixed';
                        container.style.left = '0';
                        container.style.top = '0';
                        container.style.zIndex = '-9999';
                        container.style.padding = `${marginPx}px`;
                        container.style.fontFamily = 'Arial, sans-serif';
                        container.style.fontSize = '12pt';
                        container.style.lineHeight = '1.5';
                        container.style.color = '#000';
                        let hasTextContent = false;
                        const officeText = xmlDoc.getElementsByTagNameNS("*", "text")[0];
                        if (officeText) {
                            for (let i = 0; i < officeText.children.length; i++) {
                                hasTextContent = processNode(container, officeText.children[i]) || hasTextContent;
                            }
                        }
                        if (!hasTextContent) {
                            const emptyParagraph = document.createElement('p');
                            emptyParagraph.textContent = 'No text content found.';
                            container.appendChild(emptyParagraph);
                        }
                        let canvas: HTMLCanvasElement;
                        try {
                            document.body.appendChild(container);

                            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

                            const renderHeight = Math.max(container.scrollHeight, container.offsetHeight);
                            assertRenderableArea(pageWidthPx, renderHeight);
                            const estimatedPages = Math.max(1, Math.ceil(renderHeight / (pageHeightPx - 120)));
                            if (importedPageCount + estimatedPages > MAX_IMPORT_PAGES) {
                                throw new Error(`Import would exceed the ${MAX_IMPORT_PAGES} page limit.`);
                            }

                            canvas = await html2canvas(container, {
                                scale: 1,
                                useCORS: true,
                                logging: false,
                                width: pageWidthPx,
                                windowWidth: pageWidthPx
                            });
                        } finally {
                            container.remove();
                        }

                        assertRenderableArea(canvas.width, canvas.height);

                        // Create PDF with pdf-lib
                        const pdfDoc = await pdfLib.PDFDocument.create();

                        // A4 size in points (72 DPI)
                        const pageWidthPt = 595.28;
                        const pageHeightPt = 841.89;

                        // Margins in pixels (for content area)
                        const marginTopPx = 60;
                        const marginBottomPx = 60;
                        const contentHeightPx = pageHeightPx - marginTopPx - marginBottomPx;

                        // Helper function to find the "whitest" row near a target Y position
                        const findOptimalBreakPoint = (targetY: number, searchRange: number = 80): number => {
                            const tempCanvas = document.createElement('canvas');
                            tempCanvas.width = pageWidthPx;
                            tempCanvas.height = searchRange * 2;
                            const tempCtx = tempCanvas.getContext('2d');

                            if (!tempCtx) return targetY;

                            const startY = Math.max(0, targetY - searchRange);
                            const endY = Math.min(canvas.height, targetY + searchRange);
                            const actualHeight = endY - startY;

                            tempCtx.drawImage(canvas, 0, startY, pageWidthPx, actualHeight, 0, 0, pageWidthPx, actualHeight);
                            const imageData = tempCtx.getImageData(0, 0, pageWidthPx, actualHeight);
                            const data = imageData.data;

                            let bestY = targetY;
                            let bestWhiteness = -1;

                            for (let y = 0; y < actualHeight; y++) {
                                let rowWhiteness = 0;
                                for (let x = 0; x < pageWidthPx; x++) {
                                    const i = (y * pageWidthPx + x) * 4;
                                    const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
                                    rowWhiteness += brightness;
                                }
                                rowWhiteness /= pageWidthPx;

                                const distancePenalty = Math.abs(y - searchRange) * 0.1;
                                const score = rowWhiteness - distancePenalty;

                                if (score > bestWhiteness) {
                                    bestWhiteness = score;
                                    bestY = startY + y;
                                }
                            }

                            return bestY;
                        };

                        // Calculate break points with smart detection
                        const breakPoints: number[] = [0];
                        let currentY = 0;

                        while (currentY + contentHeightPx < canvas.height) {
                            const idealBreak = currentY + contentHeightPx;
                            const optimalBreak = findOptimalBreakPoint(idealBreak);
                            breakPoints.push(optimalBreak);
                            currentY = optimalBreak;
                        }
                        breakPoints.push(canvas.height);

                        const numPages = breakPoints.length - 1;

                        for (let p = 0; p < numPages; p++) {
                            const sliceCanvas = document.createElement('canvas');
                            sliceCanvas.width = pageWidthPx;
                            sliceCanvas.height = pageHeightPx;
                            const ctx = sliceCanvas.getContext('2d');

                            if (ctx) {
                                ctx.fillStyle = 'white';
                                ctx.fillRect(0, 0, pageWidthPx, pageHeightPx);

                                const sourceY = breakPoints[p];
                                const sourceHeight = Math.min(contentHeightPx, breakPoints[p + 1] - sourceY);

                                // Draw with top margin offset
                                ctx.drawImage(
                                    canvas,
                                    0, sourceY, pageWidthPx, sourceHeight,
                                    0, marginTopPx, pageWidthPx, sourceHeight
                                );
                            }

                            const sliceBytes = await canvasToPngBytes(sliceCanvas);
                            const sliceImage = await pdfDoc.embedPng(sliceBytes);

                            const page = pdfDoc.addPage([pageWidthPt, pageHeightPt]);
                            page.drawImage(sliceImage, {
                                x: 0,
                                y: 0,
                                width: pageWidthPt,
                                height: pageHeightPt,
                            });
                        }

                        const pdfBytes = await pdfDoc.save();
                        arrayBuffer = toArrayBuffer(pdfBytes);

                        const newFileName = file.name.replace(/\.odt$/i, '.pdf');
                        const newFile = new File([arrayBuffer], newFileName, { type: 'application/pdf' });

                        const { pdfDoc: odtPdf, loadingTask: odtTask } = await loadPdfDocumentWithTask({ data: cloneArrayBuffer(arrayBuffer) });

                        storeImportedFile(fileId, {
                            id: fileId,
                            file: newFile,
                            pdfDoc: odtPdf,
                            loadingTask: odtTask,
                            pageCount: odtPdf.numPages
                        });

                        appendFilePages(fileId, odtPdf.numPages);
                        continue;
                    }
                }

                const { pdfDoc, loadingTask } = await loadPdfDocumentWithTask({ data: cloneArrayBuffer(arrayBuffer) });

                storeImportedFile(fileId, {
                    id: fileId,
                    file,
                    pdfDoc,
                    loadingTask,
                    pageCount: pdfDoc.numPages
                });

                appendFilePages(fileId, pdfDoc.numPages);
            } catch (error) {
                const failedFileData = newFilesMap[fileId];
                if (failedFileData) {
                    importedFileBytes -= failedFileData.file.size;
                    releasePdfDocument(failedFileData.pdfDoc);
                }
                delete newFilesMap[fileId];
                const isPasswordProtectedPdf = getImportFileKind(file) === 'pdf' &&
                    isLikelyInvalidPasswordError(error);
                if (isPasswordProtectedPdf) {
                    passwordProtectedFiles.push(file);
                } else if (error instanceof ImportLimitError) {
                    failedReasons.push(`${file.name}: ${error.message}`);
                } else {
                    failedReasons.push(file.name);
                }
                if (!isPasswordProtectedPdf) {
                    console.error(`Error loading file ${file.name}:`, error);
                }
            }
        }

            if (passwordProtectedFiles.length > 0) {
                labels.onPasswordRequired?.(passwordProtectedFiles[0]);
            }
            if (failedReasons.length > 0) {
                notifyError(`${labels.failedPrefix}\n${failedReasons.join('\n')}`);
            }
            if (Object.keys(newFilesMap).length > 0) {
                setFiles(prev => ({ ...prev, ...newFilesMap }));
            }
            if (newPages.length > 0) {
                setPages(prev => [...prev, ...newPages]);
                if (!failedReasons.length && passwordProtectedFiles.length === 0 && labels.success) {
                    notifySuccess(labels.success);
                }
            }
        } finally {
            isImportingRef.current = false;
            setIsProcessing(false);
        }
    }, [pages.length, setPages, notifyError, notifySuccess]);

    const movePage = useCallback((activeId: string, overId: string) => {
        setPages((items) => {
            const oldIndex = items.findIndex((item) => item.id === activeId);
            const newIndex = items.findIndex((item) => item.id === overId);
            return arrayMove(items, oldIndex, newIndex);
        });
    }, [setPages]);

    const rotatePage = useCallback((pageId: string) => {
        setPages(prev => prev.map(page => {
            if (page.id === pageId) {
                return { ...page, rotation: (page.rotation + 90) % 360 };
            }
            return page;
        }));
    }, [setPages]);

    const rotatePages = useCallback((pageIds: string[]) => {
        if (pageIds.length === 0) {
            return;
        }
        const idSet = new Set(pageIds);
        setPages(prev => prev.map(page => (
            idSet.has(page.id)
                ? { ...page, rotation: (page.rotation + 90) % 360 }
                : page
        )));
    }, [setPages]);

    const deletePage = useCallback((pageId: string) => {
        setPages(prev => prev.filter(page => page.id !== pageId));
    }, [setPages]);

    const deletePages = useCallback((pageIds: string[]) => {
        if (pageIds.length === 0) {
            return;
        }
        const idSet = new Set(pageIds);
        setPages(prev => prev.filter(page => !idSet.has(page.id)));
    }, [setPages]);

    const duplicatePages = useCallback((pageIds: string[]) => {
        if (pageIds.length === 0) {
            return;
        }

        const idSet = new Set(pageIds);
        setPages(prev => {
            const next: EditorPage[] = [];
            for (const page of prev) {
                next.push(page);
                if (idSet.has(page.id)) {
                    next.push({
                        ...page,
                        id: `${page.fileId}-${page.pageIndex}-${createId().slice(0, 8)}`,
                        annotations: structuredClone(page.annotations),
                        contentEdits: structuredClone(page.contentEdits),
                    });
                }
            }
            return next;
        });
    }, [setPages]);

    const clearAll = useCallback(() => {
        Object.values(filesRef.current).forEach((fileData) => {
            releasePdfDocument(fileData.pdfDoc);
        });
        filesRef.current = {};
        setFiles({});
        // Reset history completely
        setPagesHistory([[]]);
        setPagesCurrentIndex(0);
        setPrintOverlayOptions(DEFAULT_PRINT_OVERLAY_OPTIONS);
        void clearSensitiveBrowserData();
        setHasSavedSession(false);
    }, [setPagesHistory, setPagesCurrentIndex]);

    const applyAnnotationsToPage = useCallback(async (
        pdfPage: PDFPage,
        annotations: Annotation[],
        pageHeight: number,
        pageWidth: number,
        editorCanvasWidth: number,
        editorCanvasHeight: number,
    ) => {
        const pdfLib = await loadPdfLib();
        const marginPercent = Math.max(0, Math.min(printOverlayOptions.marginPercent, 20));
        const cropPercent = Math.max(0, Math.min(printOverlayOptions.cropPercent, 20));
        const cropZoom = getCropZoom(cropPercent);
        const contentBox = getContentBox(pageWidth, pageHeight, marginPercent);
        const safeEditorWidth = Math.max(1, editorCanvasWidth);
        const safeEditorHeight = Math.max(1, editorCanvasHeight);
        const scaleX = (contentBox.width / safeEditorWidth) * cropZoom;
        const scaleY = (contentBox.height / safeEditorHeight) * cropZoom;
        const cropInsetX = (safeEditorWidth * cropPercent) / 100;
        const cropInsetY = (safeEditorHeight * cropPercent) / 100;

        const transformCoords = (x: number, y: number) => {
            return {
                x: contentBox.x + ((x - cropInsetX) * scaleX),
                y: contentBox.y + contentBox.height - ((y - cropInsetY) * scaleY)
            };
        };

        const getStandardFontName = (data: TextAnnotationData) => {
            const isSerif = data.fontFamily === 'Times New Roman' || data.fontFamily === 'Georgia';
            const isMonospace = data.fontFamily === 'Courier New';

            if (isSerif) {
                if (data.bold && data.italic) return pdfLib.StandardFonts.TimesRomanBoldItalic;
                if (data.bold) return pdfLib.StandardFonts.TimesRomanBold;
                if (data.italic) return pdfLib.StandardFonts.TimesRomanItalic;
                return pdfLib.StandardFonts.TimesRoman;
            }
            if (isMonospace) {
                if (data.bold && data.italic) return pdfLib.StandardFonts.CourierBoldOblique;
                if (data.bold) return pdfLib.StandardFonts.CourierBold;
                if (data.italic) return pdfLib.StandardFonts.CourierOblique;
                return pdfLib.StandardFonts.Courier;
            }
            if (data.bold && data.italic) return pdfLib.StandardFonts.HelveticaBoldOblique;
            if (data.bold) return pdfLib.StandardFonts.HelveticaBold;
            if (data.italic) return pdfLib.StandardFonts.HelveticaOblique;
            return pdfLib.StandardFonts.Helvetica;
        };

        const fontCache = new Map<string, Awaited<ReturnType<typeof pdfPage.doc.embedFont>>>();
        const getFont = async (data: TextAnnotationData) => {
            const fontName = getStandardFontName(data);
            const cached = fontCache.get(fontName);
            if (cached) return cached;
            const font = await pdfPage.doc.embedFont(fontName);
            fontCache.set(fontName, font);
            return font;
        };

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
                const font = await getFont(data);

                const renderedLines = data.text.split(/\r?\n/);
                const lines = renderedLines.length > 0 ? renderedLines : [''];
                const scaledFontSize = data.fontSize * scaleY;
                const lineHeight = scaledFontSize * 1.25;
                const editorLineHeight = data.fontSize * 1.25;

                for (const [index, line] of lines.entries()) {
                    const lineTopY = y - (index * lineHeight);
                    try {
                        font.encodeText(line.length > 0 ? line : ' ');
                    } catch {
                        await drawRasterizedTextLine(
                            line,
                            data,
                            x,
                            lineTopY,
                            editorLineHeight,
                            ann.rotation,
                        );
                        continue;
                    }

                    pdfPage.drawText(line.length > 0 ? line : ' ', {
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
                    const p1 = transformCoords(points[i].x, points[i].y);
                    const p2 = transformCoords(points[i + 1].x, points[i + 1].y);
                    pdfPage.drawLine({
                        start: p1,
                        end: p2,
                        thickness: data.strokeWidth * Math.min(scaleX, scaleY),
                        color: hexToRgb(data.strokeColor, pdfLib.rgb),
                    });
                }
            } else if (ann.type === 'shape') {
                const data = ann.data as ShapeAnnotationData;
                const color = hexToRgb(data.strokeColor, pdfLib.rgb);
                const thickness = data.strokeWidth * Math.min(scaleX, scaleY);

                if (data.shapeType === 'rectangle') {
                        const p1 = transformCoords(ann.x, ann.y);
                        const p2 = transformCoords(ann.x + ann.width, ann.y);
                        const p3 = transformCoords(ann.x + ann.width, ann.y + ann.height);
                        const p4 = transformCoords(ann.x, ann.y + ann.height);

                        const drawLine = (start: { x: number; y: number }, end: { x: number; y: number }) =>
                            pdfPage.drawLine({ start, end, thickness, color });
                        drawLine(p1, p2);
                        drawLine(p2, p3);
                        drawLine(p3, p4);
                        drawLine(p4, p1);

                } else if (data.shapeType === 'circle') {
                        const cx = ann.x + ann.width / 2;
                        const cy = ann.y + ann.height / 2;
                        const center = transformCoords(cx, cy);
                    const rx = (ann.width / 2) * scaleX;
                    const ry = (ann.height / 2) * scaleY;

                        pdfPage.drawEllipse({
                            x: center.x,
                            y: center.y,
                            xScale: rx,
                            yScale: ry,
                            borderColor: color, borderWidth: thickness,
                        });
                } else if (data.shapeType === 'line') {
                        const x1 = ann.x + (data.x1 ?? 0) * ann.width;
                        const y1 = ann.y + (data.y1 ?? 0) * ann.height;
                        const x2 = ann.x + (data.x2 ?? 1) * ann.width;
                        const y2 = ann.y + (data.y2 ?? 1) * ann.height;

                        pdfPage.drawLine({
                            start: transformCoords(x1, y1),
                            end: transformCoords(x2, y2),
                            thickness, color,
                        });
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
    }, [printOverlayOptions]);

    const applyPrintOverlays = useCallback(async (
        pdfPage: PDFPage,
        pageNumber: number,
        totalPages: number,
    ) => {
        const pdfLib = await loadPdfLib();
        const { width, height } = pdfPage.getSize();
        const normalizedWatermark = printOverlayOptions.watermarkText.trim();
        const normalizedHeader = printOverlayOptions.headerText.trim();
        const normalizedFooter = printOverlayOptions.footerText.trim();
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

        if (printOverlayOptions.includePageNumbers) {
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
    }, [printOverlayOptions]);

    const buildPdfBytes = useCallback(async (sourcePages: EditorPage[]) => {
        const pdfLib = await loadPdfLib();
        const newPdf = await pdfLib.PDFDocument.create();
        const marginPercent = Math.max(0, Math.min(printOverlayOptions.marginPercent, 20));
        const cropZoom = getCropZoom(Math.max(0, Math.min(printOverlayOptions.cropPercent, 20)));
        const sourcePdfCache = new Map<string, Promise<PDFDocument>>();

        const loadSourcePdf = (fileData: EditorFile) => {
            const cachedPdf = sourcePdfCache.get(fileData.id);
            if (cachedPdf) {
                return cachedPdf;
            }

            const pdfPromise = fileData.file.arrayBuffer().then((fileBuffer) => pdfLib.PDFDocument.load(fileBuffer));
            sourcePdfCache.set(fileData.id, pdfPromise);
            return pdfPromise;
        };

        for (const [pagePosition, page] of sourcePages.entries()) {
            const fileData = files[page.fileId];
            if (!fileData) {
                continue;
            }

            const srcPdf = await loadSourcePdf(fileData);
            const srcPage = srcPdf.getPage(page.pageIndex - 1);
            const srcRotation = srcPage.getRotation().angle;
            const totalRotation = (srcRotation + page.rotation) % 360;
            let pageToEmbed = srcPage;

            if (page.contentEdits.length > 0) {
                const isolatedPdf = await pdfLib.PDFDocument.create();
                const [isolatedPage] = await isolatedPdf.copyPages(srcPdf, [page.pageIndex - 1]);
                isolatedPdf.addPage(isolatedPage);
                const { applyContentEditsToPdfPage } = await loadContentEditExporter();
                await applyContentEditsToPdfPage(isolatedPdf, isolatedPage, page.contentEdits);
                pageToEmbed = isolatedPage;
            }

            const embeddedPage = await newPdf.embedPage(pageToEmbed);

            const { width: srcWidth, height: srcHeight } = embeddedPage;
            const isRotatedSides = totalRotation === 90 || totalRotation === 270;
            const effectiveWidth = isRotatedSides ? srcHeight : srcWidth;
            const effectiveHeight = isRotatedSides ? srcWidth : srcHeight;

            let targetWidth = effectiveWidth;
            let targetHeight = effectiveHeight;

            if (pageSize !== 'Original') {
                const targetDims = PAGE_SIZES[pageSize];
                if (!targetDims) {
                    throw new Error('Invalid page size');
                }

                [targetWidth, targetHeight] = targetDims;
                if (effectiveWidth > effectiveHeight) {
                    [targetWidth, targetHeight] = [targetHeight, targetWidth];
                }
            }

            const newPage = newPdf.addPage([targetWidth, targetHeight]);
            const contentBox = getContentBox(targetWidth, targetHeight, marginPercent);
            const scale = Math.min(contentBox.width / effectiveWidth, contentBox.height / effectiveHeight);
            const destWidth = effectiveWidth * scale * cropZoom;
            const destHeight = effectiveHeight * scale * cropZoom;
            const x = contentBox.x + ((contentBox.width - destWidth) / 2);
            const y = contentBox.y + ((contentBox.height - destHeight) / 2);

            const dims = { w: srcWidth * scale, h: srcHeight * scale };
            let drawX = x;
            let drawY = y;

            dims.w *= cropZoom;
            dims.h *= cropZoom;

            if (totalRotation === 90) {
                drawX += dims.h;
            } else if (totalRotation === 180) {
                drawX += dims.w;
                drawY += dims.h;
            } else if (totalRotation === 270) {
                drawY += dims.w;
            }

            newPage.drawPage(embeddedPage, {
                x: drawX,
                y: drawY,
                width: dims.w,
                height: dims.h,
                rotate: pdfLib.degrees(totalRotation),
            });

            if (page.annotations.length > 0) {
                const legacyCanvasSize = getLegacyEditorCanvasSize(totalRotation);
                await applyAnnotationsToPage(
                    newPage,
                    page.annotations,
                    targetHeight,
                    targetWidth,
                    page.annotationCanvasWidth ?? legacyCanvasSize.width,
                    page.annotationCanvasHeight ?? legacyCanvasSize.height,
                );
            }
            await applyPrintOverlays(newPage, pagePosition + 1, sourcePages.length);
        }

        return newPdf.save();
    }, [files, pageSize, printOverlayOptions, applyAnnotationsToPage, applyPrintOverlays]);

    const exportPdf = useCallback(async (labels?: ExportLabels, pageIds?: string[]) => {
        const sourcePages = pageIds?.length
            ? orderItemsByIds(pages, pageIds, (page) => page.id)
            : pages;

        if (sourcePages.length === 0) {
            return;
        }

        setIsProcessing(true);
        try {
            const pdfBytes = await buildPdfBytes(sourcePages);
            const prefix = labels?.downloadPrefix ?? 'edited_document';
            const originalName = labels?.originalName ?? 'original';
            const filename = `${prefix}_${pageSize === 'Original' ? originalName : pageSize}.pdf`;
            downloadPdfBytes(pdfBytes, filename);
            if (labels?.missingPagesWarning && sourcePages.some((page) => !files[page.fileId])) {
                notifyError(labels.missingPagesWarning);
            } else if (labels?.success) {
                notifySuccess(labels.success);
            }
        } catch (error) {
            console.error('Error exporting PDF:', error);
            notifyError(labels?.failed ?? 'Failed to export PDF.');
        } finally {
            setIsProcessing(false);
        }
    }, [pages, files, buildPdfBytes, pageSize, notifyError, notifySuccess]);

    const exportPagesAsImages = useCallback(async (
        options: ImageExportOptions,
        labels?: ImageExportLabels,
        pageIds?: string[],
    ) => {
        const orderedPages = pageIds?.length
            ? orderItemsByIds(pages, pageIds, (page) => page.id)
            : pages;
        const sourcePages = orderedPages.filter((page) => files[page.fileId]);

        if (sourcePages.length === 0) {
            return false;
        }

        setIsProcessing(true);
        let renderedDocument: LoadedPdfDocument | null = null;
        try {
            const pdfBytes = await buildPdfBytes(sourcePages);
            renderedDocument = await loadPdfDocumentWithTask({ data: toArrayBuffer(pdfBytes) });

            const normalizedQuality = normalizeImageExportQuality(options.quality);
            const renderScale = getImageExportRenderScale(normalizedQuality);
            const formatDetails = getImageExportFormatDetails(options.format);
            const pageNumbers = sourcePages.map((page) => pages.findIndex((candidate) => candidate.id === page.id) + 1);
            const renderPlans: Array<{
                page: Awaited<ReturnType<LoadedPdfDocument['pdfDoc']['getPage']>>;
                pageNumber: number;
                viewport: ReturnType<Awaited<ReturnType<LoadedPdfDocument['pdfDoc']['getPage']>>['getViewport']>;
            }> = [];
            let totalPixels = 0;

            for (let index = 0; index < renderedDocument.pdfDoc.numPages; index += 1) {
                const pdfPage = await renderedDocument.pdfDoc.getPage(index + 1);
                const viewport = pdfPage.getViewport({ scale: renderScale });
                const pagePixels = Math.ceil(viewport.width) * Math.ceil(viewport.height);
                totalPixels += pagePixels;
                if (pagePixels > MAX_RENDER_PIXELS || totalPixels > MAX_IMAGE_EXPORT_TOTAL_PIXELS) {
                    throw new ImageExportLimitError('Image export exceeds the safe rendering limit.');
                }
                renderPlans.push({
                    page: pdfPage,
                    pageNumber: pageNumbers[index] ?? index + 1,
                    viewport,
                });
            }

            const isArchive = renderPlans.length > 1;
            const archive = isArchive ? new (await import('jszip')).default() : null;
            const pagePrefix = labels?.pagePrefix ?? 'page';

            for (const plan of renderPlans) {
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.ceil(plan.viewport.width));
                canvas.height = Math.max(1, Math.ceil(plan.viewport.height));
                const context = canvas.getContext('2d');
                if (!context) {
                    throw new Error('Canvas is unavailable for image export.');
                }

                try {
                    context.fillStyle = '#ffffff';
                    context.fillRect(0, 0, canvas.width, canvas.height);
                    await plan.page.render({
                        canvas,
                        canvasContext: context,
                        viewport: plan.viewport,
                        background: '#ffffff',
                    }).promise;
                    const imageBlob = await canvasToImageBlob(
                        canvas,
                        formatDetails.mimeType,
                        normalizedQuality / 100,
                    );
                    const filename = getImageExportFilename(
                        plan.pageNumber,
                        pages.length,
                        pagePrefix,
                        options.format,
                    );

                    if (archive) {
                        archive.file(filename, imageBlob);
                    } else {
                        downloadBlob(imageBlob, filename);
                    }
                } finally {
                    canvas.width = 1;
                    canvas.height = 1;
                }
            }

            if (archive) {
                const archiveBlob = await archive.generateAsync({
                    type: 'blob',
                    compression: 'STORE',
                });
                downloadBlob(archiveBlob, `${labels?.downloadPrefix ?? 'selected_pages_images'}.zip`);
            }

            if (labels?.missingPagesWarning && sourcePages.length < orderedPages.length) {
                notifyError(labels.missingPagesWarning);
            } else if (labels?.success) {
                notifySuccess(labels.success);
            }
            return true;
        } catch (error) {
            console.error('Error exporting pages as images:', error);
            notifyError(
                error instanceof ImageExportLimitError
                    ? labels?.limitExceeded ?? 'Reduce the quality or select fewer pages.'
                    : labels?.failed ?? 'Failed to export the selected pages as images.',
            );
            return false;
        } finally {
            if (renderedDocument) {
                try {
                    await renderedDocument.loadingTask.destroy();
                } catch {
                    // The temporary rendering task may already be released.
                }
            }
            setIsProcessing(false);
        }
    }, [pages, files, buildPdfBytes, notifyError, notifySuccess]);

    const exportPageRange = useCallback(async (
        startPage: number,
        endPage: number,
        labels?: ExportLabels,
    ) => {
        const rangeStart = Math.max(1, Math.min(startPage, endPage));
        const rangeEnd = Math.min(pages.length, Math.max(startPage, endPage));
        const sourcePages = pages.slice(rangeStart - 1, rangeEnd);

        if (sourcePages.length === 0) {
            return false;
        }

        setIsProcessing(true);
        try {
            const pdfBytes = await buildPdfBytes(sourcePages);
            const prefix = labels?.downloadPrefix ?? 'edited_document';
            const originalName = labels?.originalName ?? 'original';
            const sizeLabel = pageSize === 'Original' ? originalName : pageSize;
            const filename = `${prefix}_${rangeStart}-${rangeEnd}_${sizeLabel}.pdf`;
            downloadPdfBytes(pdfBytes, filename);
            if (labels?.missingPagesWarning && sourcePages.some((page) => !files[page.fileId])) {
                notifyError(labels.missingPagesWarning);
            } else if (labels?.success) {
                notifySuccess(labels.success);
            }
            return true;
        } catch (error) {
            console.error('Error exporting PDF range:', error);
            notifyError(labels?.failed ?? 'Failed to export PDF.');
            return false;
        } finally {
            setIsProcessing(false);
        }
    }, [pages, files, buildPdfBytes, pageSize, notifyError, notifySuccess]);

    const splitPdf = useCallback(async (
        mode: 'single' | 'odd-even',
        labels?: SplitPdfLabels,
    ) => {
        if (pages.length === 0) {
            return false;
        }

        const groups = mode === 'single'
            ? pages.map((page, index) => ({
                pages: [page],
                filename: `${labels?.splitDownloadPrefix ?? 'split_document'}_${labels?.pageSuffix ?? 'page'}-${index + 1}.pdf`
            }))
            : [
                {
                    pages: pages.filter((_, index) => index % 2 === 0),
                    filename: `${labels?.splitDownloadPrefix ?? 'split_document'}_${labels?.oddSuffix ?? 'odd'}.pdf`
                },
                {
                    pages: pages.filter((_, index) => index % 2 === 1),
                    filename: `${labels?.splitDownloadPrefix ?? 'split_document'}_${labels?.evenSuffix ?? 'even'}.pdf`
                }
            ].filter(group => group.pages.length > 0);

        setIsProcessing(true);
        try {
            for (const group of groups) {
                const pdfBytes = await buildPdfBytes(group.pages);
                downloadPdfBytes(pdfBytes, group.filename);
            }
            if (labels?.missingPagesWarning && groups.some((group) => group.pages.some((page) => !files[page.fileId]))) {
                notifyError(labels.missingPagesWarning);
            } else if (labels?.success) {
                notifySuccess(labels.success);
            }
            return true;
        } catch (error) {
            console.error('Error splitting PDF:', error);
            notifyError(labels?.failed ?? 'Failed to export PDF.');
            return false;
        } finally {
            setIsProcessing(false);
        }
    }, [pages, files, buildPdfBytes, notifyError, notifySuccess]);

    const exportProtectedPdf = useCallback(async (
        password: string,
        labels?: ProtectPdfLabels,
    ): Promise<boolean> => {
        if (pages.length === 0) {
            return false;
        }

        if (password.length === 0) {
            notifyError(labels?.invalidPassword ?? 'Please provide a valid password.');
            return false;
        }

        setIsProcessing(true);
        try {
            const rawBytes = await buildPdfBytes(pages);
            const { PDF: SecurePDF } = await import('@libpdf/core');
            const securePdf = await SecurePDF.load(rawBytes);
            securePdf.setProtection({
                userPassword: password,
                ownerPassword: createId(),
                algorithm: 'AES-256',
            });

            const protectedBytes = await securePdf.save();
            const prefix = labels?.downloadPrefix ?? 'protected_document';
            const originalName = labels?.originalName ?? 'original';
            const sizeLabel = pageSize === 'Original' ? originalName : pageSize;
            const filename = `${prefix}_${sizeLabel}.pdf`;
            downloadPdfBytes(protectedBytes, filename);
            if (labels?.missingPagesWarning && pages.some((page) => !files[page.fileId])) {
                notifyError(labels.missingPagesWarning);
            } else if (labels?.success) {
                notifySuccess(labels.success);
            }
            return true;
        } catch (error) {
            console.error('Error protecting PDF:', error);
            notifyError(labels?.failed ?? 'Failed to protect PDF.');
            return false;
        } finally {
            setIsProcessing(false);
        }
    }, [pages, files, buildPdfBytes, pageSize, notifyError, notifySuccess]);

    const unlockPdfFile = useCallback(async (
        file: File | null,
        password: string,
        labels?: UnlockPdfLabels
    ): Promise<File | null> => {
        if (!file) {
            notifyError(labels?.invalidFile ?? 'Please select a PDF file.');
            return null;
        }

        const isPdfFile = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
        if (!isPdfFile) {
            notifyError(labels?.invalidFile ?? 'Please select a PDF file.');
            return null;
        }
        if (!isAcceptedUnlockPdf(file)) {
            notifyError(labels?.invalidFile ?? 'The selected PDF is invalid or too large.');
            return null;
        }

        setIsProcessing(true);
        try {
            const sourceBuffer = await file.arrayBuffer();
            const passwordCheck = await loadPdfDocumentWithTask({
                data: cloneArrayBuffer(sourceBuffer),
                password,
            });
            releasePdfDocument(passwordCheck);

            const bytes = new Uint8Array(sourceBuffer);
            const { PDF: SecurePDF } = await import('@libpdf/core');
            const securePdf = await SecurePDF.load(bytes, { credentials: password });

            if (securePdf.isEncrypted) {
                securePdf.removeProtection();
            }

            const unlockedBytes = await securePdf.save();
            const unlockedBuffer = toArrayBuffer(unlockedBytes);
            const unlockedDocument = await loadPdfDocumentWithTask({
                data: cloneArrayBuffer(unlockedBuffer),
            });
            releasePdfDocument(unlockedDocument);

            return new File([unlockedBuffer], file.name, {
                type: 'application/pdf',
            });
        } catch (error) {
            if (isLikelyInvalidPasswordError(error)) {
                notifyError(labels?.invalidPassword ?? 'Invalid password.');
            } else {
                console.error('Error unlocking PDF:', error);
                notifyError(labels?.failed ?? 'Failed to unlock PDF.');
            }
            return null;
        } finally {
            setIsProcessing(false);
        }
    }, [notifyError]);

    const updatePageAnnotations = useCallback((
        pageId: string,
        annotations: Annotation[],
        contentEdits: ContentEdit[],
        canvasSize?: { width: number; height: number },
    ) => {
        setPages(prev => prev.map(page => {
            if (page.id === pageId) {
                return {
                    ...page,
                    annotations,
                    contentEdits,
                    annotationCanvasWidth: canvasSize?.width ?? page.annotationCanvasWidth,
                    annotationCanvasHeight: canvasSize?.height ?? page.annotationCanvasHeight,
                    previewRevision: (page.previewRevision ?? 0) + 1,
                };
            }
            return page;
        }));
    }, [setPages]);

    return {
        files,
        pages,
        isProcessing,
        notification,
        dismissNotification,
        isSessionReady,
        hasSavedSession,
        isSessionPersistenceEnabled,
        setSessionPersistenceEnabled,
        pageSize,
        setPageSize,
        printOverlayOptions,
        setPrintOverlayOptions,
        addFiles,
        movePage,
        rotatePage,
        rotatePages,
        deletePage,
        deletePages,
        duplicatePages,
        clearAll,
        exportPdf,
        exportPagesAsImages,
        exportPageRange,
        splitPdf,
        exportProtectedPdf,
        unlockPdfFile,
        undo,
        redo,
        canUndo,
        canRedo,
        updatePageAnnotations,
        notifySuccess
    };
};
