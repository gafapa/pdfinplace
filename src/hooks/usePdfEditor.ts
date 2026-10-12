import { readBrowserPreference, removeBrowserPreference, writeBrowserPreference } from '../utils/browserPreferences';
import { useState, useCallback, useEffect, useRef } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import type { Annotation } from '../types/annotations';
import type { ContentEdit } from '../features/content-editor/types';
import type { ImageCompressionLevel } from '../features/export/compressImages';
import type { FormValues } from '../features/forms/formTypes';
import { createId } from '../utils/createId';
import { getSessionPersistencePreference } from '../utils/sessionPreference';
import type { EditorFile, EditorPage, PageSize, PrintOverlayOptions, EditorNotification } from './editorTypes';
export type { EditorFile, EditorPage, PageSize, PrintOverlayOptions, EditorNotification, ImageExportOptions } from './editorTypes';
import { releasePdfDocument } from './editorResources';
import { useHistory } from './useHistory';
import { usePdfImport } from './usePdfImport';
import { usePdfExport } from './usePdfExport';
import { useEditorOperation } from './useEditorOperation';
import { useSessionPersistence, DEFAULT_PRINT_OVERLAY_OPTIONS } from './useSessionPersistence';

const OVERLAY_OPTIONS_STORAGE_KEY = 'pageforge.overlay-options';
const IMAGE_COMPRESSION_STORAGE_KEY = 'pageforge.editor.image-compression';

const getInitialImageCompression = (): ImageCompressionLevel => {
    if (typeof window === 'undefined') return 'none';
    const saved = readBrowserPreference(IMAGE_COMPRESSION_STORAGE_KEY);
    return saved === 'balanced' || saved === 'strong' ? saved : 'none';
};

const loadOverlayOptions = (): PrintOverlayOptions => {
    if (typeof window === 'undefined' || !getSessionPersistencePreference()) {
        if (typeof window !== 'undefined') {
            removeBrowserPreference(OVERLAY_OPTIONS_STORAGE_KEY);
        }
        return DEFAULT_PRINT_OVERLAY_OPTIONS;
    }

    try {
        const rawOptions = readBrowserPreference(OVERLAY_OPTIONS_STORAGE_KEY);
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

const getInitialPageSize = (): PageSize => {
    if (typeof window === 'undefined') {
        return 'Original';
    }

    const savedPageSize = readBrowserPreference('pageforge.editor.page-size');
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

    const operationController = useEditorOperation();
    const { isProcessing, operation, cancelOperation } = operationController;
    const [notification, setNotification] = useState<EditorNotification | null>(null);
    const [pageSize, setPageSize] = useState<PageSize>(getInitialPageSize);
    const [imageCompression, setImageCompression] = useState<ImageCompressionLevel>(getInitialImageCompression);
    useEffect(() => {
        writeBrowserPreference(IMAGE_COMPRESSION_STORAGE_KEY, imageCompression);
    }, [imageCompression]);
    const filesRef = useRef<Record<string, EditorFile>>({});
    const [printOverlayOptions, setPrintOverlayOptions] = useState<PrintOverlayOptions>(loadOverlayOptions);
    const notifyError = useCallback((message: string) => {
        setNotification({ id: createId(), message, tone: 'error' });
    }, []);
    const notifySuccess = useCallback((message: string) => {
        setNotification({ id: createId(), message, tone: 'success' });
    }, []);
    const dismissNotification = useCallback(() => setNotification(null), []);

    const { isSessionReady, isSessionPersistenceEnabled, hasSavedSession, sessionSaveStatus, hasUnsavedChanges, retrySessionSave, flushSession, clearSession, setSessionPersistenceEnabled } = useSessionPersistence({
        files, pages, pageSize, printOverlayOptions, setFiles, setPagesHistory, setPagesCurrentIndex, setPageSize, setPrintOverlayOptions,
    });

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

    const { addFiles } = usePdfImport({ filesRef, pages, isSessionReady, setFiles, setPages, operationController, notifyError, notifySuccess });

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

    const clearAll = useCallback(async () => {
        if (!await clearSession()) return;
        Object.values(filesRef.current).forEach((fileData) => {
            releasePdfDocument(fileData.pdfDoc);
        });
        filesRef.current = {};
        setFiles({});
        // Reset history completely
        setPagesHistory([[]]);
        setPagesCurrentIndex(0);
        setPrintOverlayOptions(DEFAULT_PRINT_OVERLAY_OPTIONS);
    }, [clearSession, setPagesHistory, setPagesCurrentIndex]);

    const { exportPdf, exportPagesAsImages, exportPageRange, splitPdf, exportProtectedPdf, unlockPdfFile } = usePdfExport({ files, pages, pageSize, printOverlayOptions, imageCompression, operationController, notifyError, notifySuccess });

    const updatePageAnnotations = useCallback((
        pageId: string,
        annotations: Annotation[],
        contentEdits: ContentEdit[],
        canvasSize?: { width: number; height: number },
        formValues?: FormValues,
    ) => {
        setPages(prev => {
            const fileId = prev.find(page => page.id === pageId)?.fileId;
            return prev.map(page => {
                if (page.id === pageId) {
                    return {
                        ...page,
                        annotations,
                        contentEdits,
                        annotationCanvasWidth: canvasSize?.width ?? page.annotationCanvasWidth,
                        annotationCanvasHeight: canvasSize?.height ?? page.annotationCanvasHeight,
                        previewRevision: (page.previewRevision ?? 0) + 1,
                        ...(formValues ? { formValues } : {}),
                    };
                }
                // Form values belong to the whole file: every page of it shows them.
                if (formValues && page.fileId === fileId && page.formValues !== formValues) {
                    return { ...page, formValues };
                }
                return page;
            });
        });
    }, [setPages]);

    return {
        files,
        pages,
        isProcessing: isProcessing || !isSessionReady,
        operation,
        cancelOperation,
        notification,
        dismissNotification,
        isSessionReady,
        hasSavedSession,
        sessionSaveStatus,
        hasUnsavedChanges,
        retrySessionSave,
        flushSession,
        isSessionPersistenceEnabled,
        setSessionPersistenceEnabled,
        pageSize,
        setPageSize,
        imageCompression,
        setImageCompression,
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
