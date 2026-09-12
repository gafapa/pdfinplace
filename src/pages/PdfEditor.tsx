import { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { usePdfEditor, type EditorFile, type EditorPage, type ImageExportOptions, type PageSize } from '../hooks/usePdfEditor';
import { PdfPreview, type PdfPreviewFinishOptions } from '../components/PdfPreview';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragOverlay } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Upload, RotateCw, Trash2, Download, Plus, ZoomIn, ZoomOut, Undo, Redo, FileText, Lock, LockOpen, Check, X, Copy, SplitSquareVertical, CheckSquare2, Square, SlidersHorizontal, Pencil, Images } from 'lucide-react';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { useI18n } from '../i18n';
import { AVAILABLE_LOCALES, type Locale } from '../i18n/locales';
import { useDialogFocus } from '../hooks/useDialogFocus';

const LazyPageEditorModal = lazy(() =>
    import('../components/PageEditorModal').then((module) => ({ default: module.PageEditorModal }))
);

// Color palette for different documents
const DOCUMENT_COLORS = [
    '#3B82F6', // blue
    '#10B981', // green
    '#F59E0B', // amber
    '#EF4444', // red
    '#8B5CF6', // violet
    '#EC4899', // pink
    '#06B6D4', // cyan
    '#F97316', // orange
];

const getDocumentColor = (fileId: string, fileIds: string[]): string => {
    const index = fileIds.indexOf(fileId);
    return DOCUMENT_COLORS[index % DOCUMENT_COLORS.length];
};

const getInitialScale = () => {
    if (typeof window === 'undefined') {
        return 1;
    }
    const savedScale = Number(localStorage.getItem('pageforge.editor.scale') ?? '1');
    return Number.isFinite(savedScale) && savedScale >= 0.5 && savedScale <= 2 ? savedScale : 1;
};

interface SortablePageProps {
    id: string;
    page: EditorPage;
    file?: EditorFile;
    onRotate: (pageId: string) => void;
    onDelete: (pageId: string) => void;
    onClickPage: (pageId: string, event: ReactMouseEvent<HTMLDivElement>) => void;
    onOpenEditor: (pageId: string) => void;
    scale: number;
    newPageIndex: number;
    documentColor: string;
    rotateLabel: string;
    deleteLabel: string;
    isSelected: boolean;
    selectionOrder: number | null;
    onToggleSelection: (pageId: string, shouldSelect: boolean) => void;
    selectLabel: string;
    deselectLabel: string;
    editLabel: string;
    finishSettings: Pick<PdfPreviewFinishOptions, 'watermarkText' | 'headerText' | 'footerText' | 'includePageNumbers' | 'cropPercent' | 'marginPercent'>;
    totalPages: number;
}

// Sortable Item Component
const SortablePage = memo(function SortablePage({
    id,
    page,
    file,
    onRotate,
    onDelete,
    onClickPage,
    onOpenEditor,
    scale,
    newPageIndex,
    documentColor,
    rotateLabel,
    deleteLabel,
    isSelected,
    selectionOrder,
    onToggleSelection,
    selectLabel,
    deselectLabel,
    editLabel,
    finishSettings,
    totalPages,
}: SortablePageProps) {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging
    } = useSortable({ id });

    const style = {
        transform: CSS.Translate.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        touchAction: 'none',
    };

    return (
        <div ref={setNodeRef} style={style} className="relative group">
            <div
                className={`document-card cursor-pointer ${isSelected ? 'ring-4 ring-blue-200 shadow-md' : ''}`}
                style={{ border: `3px solid ${isSelected ? '#2563EB' : documentColor}` }}
                {...attributes}
                {...listeners}
                onClick={(event) => onClickPage(id, event)}
            >
                <div>
                    <PdfPreview
                        key={page.previewRevision ?? 0}
                        pdfDocument={file?.pdfDoc}
                        pageIndex={page.pageIndex}
                        width={180 * scale}
                        height={180 * scale}
                        rotation={page.rotation}
                        className="pointer-events-none"
                        annotations={page.annotations}
                        contentEdits={page.contentEdits}
                        annotationCanvasWidth={page.annotationCanvasWidth}
                        annotationCanvasHeight={page.annotationCanvasHeight}
                        showPageBorder
                        finishOptions={{
                            ...finishSettings,
                            pageNumber: newPageIndex,
                            totalPages,
                        }}
                    />
                </div>
            </div>

            <div className="absolute top-1 left-1 flex items-center gap-1">
                <button
                    type="button"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                        event.stopPropagation();
                        onToggleSelection(id, !isSelected);
                    }}
                    className={`flex h-6 min-w-6 items-center justify-center rounded-full border px-1 text-[11px] font-semibold shadow-sm transition-colors ${isSelected ? 'border-blue-600 bg-blue-600 text-white hover:bg-blue-700' : 'border-gray-200 bg-white text-gray-500 hover:border-blue-300 hover:text-blue-600'}`}
                    title={isSelected ? deselectLabel : selectLabel}
                    aria-label={isSelected ? deselectLabel : selectLabel}
                >
                    {isSelected ? <Check className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
                </button>
                {selectionOrder ? (
                    <div className="flex h-6 min-w-6 items-center justify-center rounded-full bg-blue-50 px-1 text-[11px] font-semibold text-blue-700 shadow-sm">
                        {selectionOrder}
                    </div>
                ) : null}
            </div>

            {/* Overlay Actions */}
            <div className="absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity motion-reduce:transition-none">
                <button
                    type="button"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                        event.stopPropagation();
                        onOpenEditor(id);
                    }}
                    className="inline-flex h-8 w-8 items-center justify-center rounded bg-white text-gray-700 shadow hover:bg-blue-50 hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                    title={editLabel}
                    aria-label={editLabel}
                >
                    <Pencil aria-hidden="true" className="h-4 w-4" />
                </button>
                <button
                    type="button"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); onRotate(id); }}
                    className="inline-flex h-8 w-8 items-center justify-center rounded bg-white text-gray-700 shadow hover:bg-blue-50 hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                    title={rotateLabel}
                    aria-label={rotateLabel}
                >
                    <RotateCw aria-hidden="true" className="w-4 h-4" />
                </button>
                <button
                    type="button"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); onDelete(id); }}
                    className="inline-flex h-8 w-8 items-center justify-center rounded bg-white text-gray-700 shadow hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600"
                    title={deleteLabel}
                    aria-label={deleteLabel}
                >
                    <Trash2 aria-hidden="true" className="w-4 h-4" />
                </button>
            </div>
            {/* Original page number (from source file) */}
            <div
                className="absolute bottom-1 left-1 text-white text-xs font-bold px-1.5 py-0.5 rounded"
                style={{ backgroundColor: documentColor }}
            >
                {page.pageIndex}
            </div>
            {/* New page number in current document */}
            <div className="absolute bottom-1 right-1 bg-black/50 text-white text-xs px-1.5 py-0.5 rounded backdrop-blur-sm">
                #{newPageIndex}
            </div>
        </div>
    );
});

interface PdfEditorProps {
    onOpenWelcome: () => void;
}

export const PdfEditor = ({ onOpenWelcome }: PdfEditorProps) => {
    const { locale, setLocale, t } = useI18n();
    const {
        files,
        pages,
        isProcessing,
        notification,
        dismissNotification,
        isSessionReady,
        hasSavedSession,
        isSessionPersistenceEnabled,
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
        exportPdf,
        exportPagesAsImages,
        exportPageRange,
        splitPdf,
        exportProtectedPdf,
        unlockPdfFile,
        clearAll,
        undo,
        redo,
        canUndo,
        canRedo,
        updatePageAnnotations
    } = usePdfEditor();
    const [activeId, setActiveId] = useState<string | null>(null);
    const [scale, setScale] = useState(getInitialScale);
    const [selectedPageIds, setSelectedPageIds] = useState<string[]>([]);
    const [lastSelectedPageId, setLastSelectedPageId] = useState<string | null>(null);
    const [editingPageId, setEditingPageId] = useState<string | null>(null);
    const [rangeStart, setRangeStart] = useState('1');
    const [rangeEnd, setRangeEnd] = useState('1');
    const [isExportDialogOpen, setIsExportDialogOpen] = useState(false);
    const [isImageExportDialogOpen, setIsImageExportDialogOpen] = useState(false);
    const [imageExportFormat, setImageExportFormat] = useState<ImageExportOptions['format']>('jpeg');
    const [imageExportQuality, setImageExportQuality] = useState(80);
    const [isFinishDialogOpen, setIsFinishDialogOpen] = useState(false);
    const [isProtectDialogOpen, setIsProtectDialogOpen] = useState(false);
    const [isUnlockDialogOpen, setIsUnlockDialogOpen] = useState(false);
    const [protectPassword, setProtectPassword] = useState('');
    const [protectPasswordConfirm, setProtectPasswordConfirm] = useState('');
    const [unlockPassword, setUnlockPassword] = useState('');
    const [unlockFile, setUnlockFile] = useState<File | null>(null);
    const [uiError, setUiError] = useState('');
    const [isClearAllDialogOpen, setIsClearAllDialogOpen] = useState(false);
    const addFilesInputRef = useRef<HTMLInputElement>(null);
    const selectedPageIdsValid = useMemo(
        () => selectedPageIds.filter(pageId => pages.some(page => page.id === pageId)),
        [selectedPageIds, pages]
    );
    const selectedPageIdSet = useMemo(() => new Set(selectedPageIdsValid), [selectedPageIdsValid]);
    const selectionOrderMap = useMemo(
        () => new Map(selectedPageIdsValid.map((pageId, index) => [pageId, index + 1])),
        [selectedPageIdsValid],
    );

    const toolbarButtonClass = "toolbar-button text-xs font-medium whitespace-nowrap motion-reduce:transition-none";
    const toolbarIconButtonClass = toolbarButtonClass;
    const canExport = pages.length > 0 && !isProcessing;
    const hasSelectedPages = selectedPageIdsValid.length > 0 && !isProcessing;
    const activeOverlayCount = [
        printOverlayOptions.watermarkText.trim().length > 0,
        printOverlayOptions.headerText.trim().length > 0,
        printOverlayOptions.footerText.trim().length > 0,
        printOverlayOptions.includePageNumbers,
        printOverlayOptions.cropPercent > 0,
        printOverlayOptions.marginPercent > 0,
    ].filter(Boolean).length;

    useEffect(() => {
        localStorage.setItem('pageforge.editor.scale', scale.toString());
    }, [scale]);

    useEffect(() => {
        localStorage.setItem('pageforge.editor.page-size', pageSize);
    }, [pageSize]);

    useEffect(() => {
        localStorage.removeItem('pageforge.editor.export-panel-open');
    }, []);

    useEffect(() => {
        if (notification?.tone !== 'success') {
            return;
        }
        const timer = window.setTimeout(() => dismissNotification(), 4000);
        return () => window.clearTimeout(timer);
    }, [notification, dismissNotification]);

    useEffect(() => {
        const handleBeforeUnload = (event: BeforeUnloadEvent) => {
            if (!isProcessing && pages.length > 0 && !isSessionPersistenceEnabled) {
                event.preventDefault();
                event.returnValue = '';
            }
        };
        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => window.removeEventListener('beforeunload', handleBeforeUnload);
    }, [isProcessing, pages.length, isSessionPersistenceEnabled]);

    const openUnlockDialogForFile = useCallback((file: File) => {
        setUnlockFile(file);
        setUnlockPassword('');
        setUiError('');
        setIsUnlockDialogOpen(true);
    }, []);

    const getImportLabels = useCallback(() => ({
        skippedPrefix: t('editor.importSkipped'),
        failedPrefix: t('editor.importFailed'),
        fileCount: t('editor.importFileCount'),
        unsupported: t('editor.importUnsupported'),
        fileSize: t('editor.importFileSize'),
        batchSize: t('editor.importBatchSize'),
        success: t('editor.importSuccess'),
        onPasswordRequired: openUnlockDialogForFile,
    }), [openUnlockDialogForFile, t]);

    const handleFilesPicked = useCallback((filesList: FileList | null) => {
        if (!filesList || isProcessing) {
            return;
        }
        addFiles(Array.from(filesList), getImportLabels());
    }, [addFiles, getImportLabels, isProcessing]);

    const triggerAddFiles = useCallback(() => {
        if (isProcessing) {
            return;
        }
        addFilesInputRef.current?.click();
    }, [isProcessing]);

    const closeExportDialog = useCallback(() => {
        setIsExportDialogOpen(false);
    }, []);

    const closeImageExportDialog = useCallback(() => {
        setIsImageExportDialogOpen(false);
    }, []);

    const closeFinishDialog = useCallback(() => {
        setIsFinishDialogOpen(false);
    }, []);

    const handleExport = useCallback(() => {
        if (!canExport) {
            return;
        }

        closeExportDialog();
        exportPdf({
            failed: t('editor.exportFailed'),
            downloadPrefix: t('editor.downloadPrefix'),
            originalName: t('editor.originalSizeName'),
            missingPagesWarning: t('editor.missingPagesWarning'),
            success: t('editor.exportSuccess'),
        });
    }, [
        canExport,
        closeExportDialog,
        exportPdf,
        t
    ]);

    const handleExportSelection = useCallback(() => {
        if (selectedPageIdsValid.length === 0 || isProcessing) {
            return;
        }

        exportPdf({
            failed: t('editor.exportFailed'),
            downloadPrefix: t('editor.downloadPrefix'),
            originalName: t('editor.originalSizeName'),
            missingPagesWarning: t('editor.missingPagesWarning'),
            success: t('editor.exportSuccess'),
        }, selectedPageIdsValid);
    }, [selectedPageIdsValid, isProcessing, exportPdf, t]);

    const handleExportSelectionAsImages = useCallback(async () => {
        if (selectedPageIdsValid.length === 0 || isProcessing) {
            return;
        }

        closeImageExportDialog();
        await exportPagesAsImages({
            format: imageExportFormat,
            quality: imageExportQuality,
        }, {
            failed: t('editor.imageExportFailed'),
            limitExceeded: t('editor.imageExportLimitExceeded'),
            missingPagesWarning: t('editor.missingPagesWarning'),
            pagePrefix: t('editor.imagePagePrefix'),
            downloadPrefix: t('editor.imageDownloadPrefix'),
            success: t('editor.imageExportSuccess'),
        }, selectedPageIdsValid);
    }, [
        selectedPageIdsValid,
        isProcessing,
        closeImageExportDialog,
        exportPagesAsImages,
        imageExportFormat,
        imageExportQuality,
        t,
    ]);

    const handleExportRange = useCallback(async () => {
        const start = Number(rangeStart);
        const end = Number(rangeEnd);

        if (
            !Number.isInteger(start) ||
            !Number.isInteger(end) ||
            start < 1 ||
            end < 1 ||
            start > pages.length ||
            end > pages.length ||
            start > end
        ) {
            setUiError(t('editor.invalidRange'));
            return;
        }

        closeExportDialog();
        await exportPageRange(start, end, {
            failed: t('editor.exportFailed'),
            downloadPrefix: t('editor.downloadPrefix'),
            originalName: t('editor.originalSizeName'),
            missingPagesWarning: t('editor.missingPagesWarning'),
            success: t('editor.exportSuccess'),
        });
    }, [closeExportDialog, rangeStart, rangeEnd, pages.length, exportPageRange, t]);

    const handleSplitSingle = useCallback(async () => {
        closeExportDialog();
        await splitPdf('single', {
            failed: t('editor.exportFailed'),
            downloadPrefix: t('editor.downloadPrefix'),
            originalName: t('editor.originalSizeName'),
            missingPagesWarning: t('editor.missingPagesWarning'),
            success: t('editor.exportSuccess'),
            splitDownloadPrefix: t('editor.splitDownloadPrefix'),
            oddSuffix: t('editor.splitOddFile'),
            evenSuffix: t('editor.splitEvenFile'),
            pageSuffix: t('editor.splitPageFile'),
        });
    }, [closeExportDialog, splitPdf, t]);

    const handleSplitOddEven = useCallback(async () => {
        closeExportDialog();
        await splitPdf('odd-even', {
            failed: t('editor.exportFailed'),
            downloadPrefix: t('editor.downloadPrefix'),
            originalName: t('editor.originalSizeName'),
            missingPagesWarning: t('editor.missingPagesWarning'),
            success: t('editor.exportSuccess'),
            splitDownloadPrefix: t('editor.splitDownloadPrefix'),
            oddSuffix: t('editor.splitOddFile'),
            evenSuffix: t('editor.splitEvenFile'),
            pageSuffix: t('editor.splitPageFile'),
        });
    }, [closeExportDialog, splitPdf, t]);

    const clearSelection = useCallback(() => {
        setSelectedPageIds([]);
        setLastSelectedPageId(null);
    }, []);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            const isFormField = Boolean(
                target && (
                    target.tagName === 'INPUT' ||
                    target.tagName === 'SELECT' ||
                    target.tagName === 'TEXTAREA' ||
                    target.isContentEditable
                ),
            );
            const isDialogOpen = editingPageId !== null ||
                isExportDialogOpen ||
                isImageExportDialogOpen ||
                isFinishDialogOpen ||
                isProtectDialogOpen ||
                isUnlockDialogOpen ||
                isClearAllDialogOpen;

            if (isFormField || isDialogOpen || isProcessing) {
                return;
            }

            const hasModifier = e.ctrlKey || e.metaKey;
            if (hasModifier && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
                e.preventDefault();
                if (e.shiftKey) {
                    redo();
                } else {
                    undo();
                }
                return;
            }
            if (hasModifier && (e.key === 'y' || e.key === 'Y')) {
                e.preventDefault();
                redo();
                return;
            }
            if ((e.key === 'Delete' || e.key === 'Backspace') && selectedPageIdsValid.length > 0) {
                e.preventDefault();
                deletePages(selectedPageIdsValid);
                clearSelection();
                return;
            }
            if (e.key === 'Escape' && selectedPageIdsValid.length > 0) {
                clearSelection();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [
        editingPageId,
        isExportDialogOpen,
        isImageExportDialogOpen,
        isFinishDialogOpen,
        isProtectDialogOpen,
        isUnlockDialogOpen,
        isClearAllDialogOpen,
        isProcessing,
        redo,
        undo,
        selectedPageIdsValid,
        deletePages,
        clearSelection,
    ]);

    const selectAllPages = useCallback(() => {
        setSelectedPageIds(pages.map(page => page.id));
        setLastSelectedPageId(pages.length > 0 ? pages[pages.length - 1].id : null);
    }, [pages]);

    const handleBatchRotate = useCallback(() => {
        if (selectedPageIdsValid.length === 0 || isProcessing) {
            return;
        }
        rotatePages(selectedPageIdsValid);
    }, [selectedPageIdsValid, isProcessing, rotatePages]);

    const handleBatchDelete = useCallback(() => {
        if (selectedPageIdsValid.length === 0 || isProcessing) {
            return;
        }
        deletePages(selectedPageIdsValid);
        clearSelection();
    }, [selectedPageIdsValid, isProcessing, deletePages, clearSelection]);

    const handleBatchDuplicate = useCallback(() => {
        if (selectedPageIdsValid.length === 0 || isProcessing) {
            return;
        }
        duplicatePages(selectedPageIdsValid);
    }, [selectedPageIdsValid, isProcessing, duplicatePages]);

    const handleToggleSelection = useCallback((pageId: string, shouldSelect: boolean) => {
        setSelectedPageIds(prev => {
            const alreadySelected = prev.includes(pageId);

            if (shouldSelect) {
                if (alreadySelected) {
                    return prev;
                }
                return [...prev, pageId];
            }

            if (!alreadySelected) {
                return prev;
            }

            return prev.filter(id => id !== pageId);
        });
        setLastSelectedPageId(prev => (shouldSelect ? pageId : prev === pageId ? null : prev));
    }, []);

    const handlePageClick = useCallback((pageId: string, event: ReactMouseEvent<HTMLDivElement>) => {
        if (event.detail > 1) {
            return;
        }

        const pageIndex = pages.findIndex(page => page.id === pageId);
        if (pageIndex === -1) {
            return;
        }

        if (event.shiftKey && lastSelectedPageId) {
            const lastIndex = pages.findIndex(page => page.id === lastSelectedPageId);
            if (lastIndex !== -1) {
                const startIndex = Math.min(lastIndex, pageIndex);
                const endIndex = Math.max(lastIndex, pageIndex);
                const rangeIds = pages.slice(startIndex, endIndex + 1).map(page => page.id);
                setSelectedPageIds(prev => Array.from(new Set([...prev, ...rangeIds])));
                return;
            }
        }

        handleToggleSelection(pageId, !selectedPageIdSet.has(pageId));
    }, [handleToggleSelection, lastSelectedPageId, pages, selectedPageIdSet]);

    const handleOpenEditor = useCallback((pageId: string) => {
        setEditingPageId(pageId);
    }, []);

    const closeProtectDialog = useCallback(() => {
        setIsProtectDialogOpen(false);
        setProtectPassword('');
        setProtectPasswordConfirm('');
        setUiError('');
    }, []);

    const closeUnlockDialog = useCallback(() => {
        setIsUnlockDialogOpen(false);
        setUnlockPassword('');
        setUnlockFile(null);
        setUiError('');
    }, []);

    const handleProtectExport = useCallback(async () => {
        if (!canExport) {
            return;
        }

        if (protectPassword.trim() !== protectPasswordConfirm.trim()) {
            setUiError(t('editor.passwordMismatch'));
            return;
        }

        const success = await exportProtectedPdf(protectPassword, {
            failed: t('editor.protectFailed'),
            invalidPassword: t('editor.invalidPassword'),
            downloadPrefix: t('editor.protectedDownloadPrefix'),
            originalName: t('editor.originalSizeName'),
            missingPagesWarning: t('editor.missingPagesWarning'),
            success: t('editor.protectSuccess'),
        });

        if (success) {
            closeProtectDialog();
        }
    }, [
        canExport,
        protectPassword,
        protectPasswordConfirm,
        exportProtectedPdf,
        t,
        closeProtectDialog,
    ]);

    const handleUnlockImport = useCallback(async () => {
        const unlockedFile = await unlockPdfFile(unlockFile, unlockPassword, {
            failed: t('editor.unlockFailed'),
            invalidPassword: t('editor.invalidPassword'),
            invalidFile: t('editor.unlockInvalidFile'),
        });

        if (unlockedFile) {
            closeUnlockDialog();
            await addFiles([unlockedFile], getImportLabels());
        }
    }, [addFiles, closeUnlockDialog, getImportLabels, t, unlockFile, unlockPassword, unlockPdfFile]);

    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                distance: 8,
            },
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    );
    const exportDialogRef = useDialogFocus<HTMLDivElement>(isExportDialogOpen, closeExportDialog);
    const imageExportDialogRef = useDialogFocus<HTMLDivElement>(isImageExportDialogOpen, closeImageExportDialog);
    const finishDialogRef = useDialogFocus<HTMLDivElement>(isFinishDialogOpen, closeFinishDialog);
    const protectDialogRef = useDialogFocus<HTMLDivElement>(isProtectDialogOpen, closeProtectDialog);
    const unlockDialogRef = useDialogFocus<HTMLDivElement>(isUnlockDialogOpen, closeUnlockDialog);
    const closeClearAllDialog = useCallback(() => setIsClearAllDialogOpen(false), []);
    const clearAllDialogRef = useDialogFocus<HTMLDivElement>(isClearAllDialogOpen, closeClearAllDialog);

    const handleDragStart = (event: DragStartEvent) => {
        setActiveId(String(event.active.id));
    };

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;

        if (over && active.id !== over.id) {
            movePage(String(active.id), String(over.id));
        }

        setActiveId(null);
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (isProcessing) {
            return;
        }
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            const droppedFiles = Array.from(e.dataTransfer.files).filter(file =>
                file.type === 'application/pdf' ||
                file.type === 'image/jpeg' ||
                file.type === 'image/png' ||
                file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
                file.type === 'application/vnd.oasis.opendocument.text' ||
                /\.(pdf|jpg|jpeg|png|docx|odt)$/i.test(file.name)
            );
            if (droppedFiles.length > 0) {
                addFiles(droppedFiles, getImportLabels());
            }
        }
    };

    return (
        <div
            className="workspace-shell relative flex h-full flex-col overflow-hidden"
            onDragOver={handleDragOver}
            onDrop={handleDrop}
        >
            <div
                className="pointer-events-none fixed left-1/2 top-3 z-[100] w-[min(92vw,36rem)] -translate-x-1/2"
                aria-live="assertive"
                aria-atomic="true"
            >
                {(notification || uiError) ? (() => {
                    const isError = uiError.length > 0 || notification?.tone !== 'success';
                    return (
                        <div
                            role="alert"
                            className={`pointer-events-auto flex items-start gap-3 whitespace-pre-line rounded-lg border p-3 text-sm shadow-xl ${
                                isError
                                    ? 'border-red-200 bg-white text-red-800'
                                    : 'border-green-200 bg-white text-green-800'
                            }`}
                        >
                            <span className="flex-1">{uiError || notification?.message}</span>
                            <button
                                type="button"
                                onClick={() => {
                                    setUiError('');
                                    dismissNotification();
                                }}
                                className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 ${
                                    isError ? 'hover:bg-red-50 focus-visible:ring-red-600' : 'hover:bg-green-50 focus-visible:ring-green-600'
                                }`}
                                title={t('common.close')}
                                aria-label={t('common.close')}
                            >
                                <X aria-hidden="true" className="h-4 w-4" />
                            </button>
                        </div>
                    );
                })() : null}
            </div>
            <div role="status" aria-live="polite" className="sr-only">
                {isProcessing ? t('common.processing') : ''}
            </div>
            {isProcessing ? (
                <div className="pointer-events-none fixed inset-0 z-[90] flex items-start justify-center" aria-hidden="true">
                    <div className="mt-20 flex items-center gap-3 rounded-xl border border-gray-200 bg-white/95 px-4 py-3 text-sm font-medium text-gray-700 shadow-xl backdrop-blur">
                        <span className="h-5 w-5 animate-spin rounded-full border-2 border-blue-500 border-t-transparent motion-reduce:animate-none" />
                        {t('common.processing')}
                    </div>
                </div>
            ) : null}
            <input
                ref={addFilesInputRef}
                type="file"
                multiple
                accept=".pdf, .jpg, .jpeg, .png, .docx, .odt"
                className="hidden"
                onChange={(e) => {
                    handleFilesPicked(e.target.files);
                    e.target.value = '';
                }}
            />
            {/* Toolbar */}
            <div className="workspace-header">
                <div className="workspace-header-top">
                    <button
                        type="button"
                        onClick={onOpenWelcome}
                        className="flex min-w-0 shrink items-center gap-2 rounded-lg text-left"
                        title={t('welcome.open')}
                        aria-label={t('welcome.open')}
                    >
                        <div className="brand-mark">
                            <FileText aria-hidden="true" className="h-5 w-5" />
                        </div>
                        <div className="hidden min-w-0 flex-col sm:flex">
                            <span className="text-base sm:text-lg font-bold tracking-tight text-gray-900">{t('app.title')}</span>
                            <span className="text-[11px] text-gray-500">
                                {!isSessionReady
                                    ? t('editor.restoringSession')
                                    : !isSessionPersistenceEnabled
                                        ? t('editor.sessionPersistenceOff')
                                        : hasSavedSession
                                        ? t('editor.sessionSaved')
                                        : t('editor.sessionEmpty')}
                            </span>
                        </div>
                    </button>
                    <div className="workspace-preferences">
                        <div className="header-action-group header-finish-actions">
                            <button
                                type="button"
                                onClick={() => setIsFinishDialogOpen(true)}
                                className={`${toolbarIconButtonClass} relative`}
                                title={t('editor.overlaySettings')}
                                aria-label={t('editor.overlaySettings')}
                            >
                                <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
                                {activeOverlayCount > 0 ? (
                                    <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-blue-600 px-1 text-center text-[10px] font-bold leading-4 text-white">
                                        {activeOverlayCount}
                                    </span>
                                ) : null}
                            </button>
                        </div>
                        <div className="header-action-group header-history-actions">
                            <button
                                type="button"
                                onClick={undo}
                                disabled={!canUndo}
                                className={toolbarIconButtonClass}
                                title={t('editor.undo')}
                                aria-label={t('editor.undo')}
                            >
                                <Undo aria-hidden="true" className="h-4 w-4" />
                            </button>
                            <button
                                type="button"
                                onClick={redo}
                                disabled={!canRedo}
                                className={toolbarIconButtonClass}
                                title={t('editor.redo')}
                                aria-label={t('editor.redo')}
                            >
                                <Redo aria-hidden="true" className="h-4 w-4" />
                            </button>
                        </div>
                        <div className="header-action-group header-document-actions">
                            <button
                                type="button"
                                onClick={triggerAddFiles}
                                disabled={isProcessing}
                                className={toolbarIconButtonClass}
                                title={t('common.add')}
                                aria-label={t('common.add')}
                            >
                                <Plus aria-hidden="true" className="h-4 w-4" />
                            </button>
                            <button
                                type="button"
                                onClick={() => setIsClearAllDialogOpen(true)}
                                disabled={isProcessing || pages.length === 0}
                                className={toolbarIconButtonClass}
                                title={t('common.clear')}
                                aria-label={t('common.clear')}
                            >
                                <Trash2 aria-hidden="true" className="h-4 w-4" />
                            </button>
                            <button
                                type="button"
                                onClick={() => setIsExportDialogOpen(true)}
                                disabled={isProcessing}
                                className={toolbarIconButtonClass}
                                title={t('common.export')}
                                aria-label={t('common.export')}
                            >
                                <Download aria-hidden="true" className="h-4 w-4" />
                            </button>
                        </div>
                        <div className="header-language-control">
                            <label htmlFor="language-select" className="text-xs font-medium text-gray-600 sr-only">
                                {t('common.language')}
                            </label>
                            <select
                                id="language-select"
                                value={locale}
                                onChange={(e) => setLocale(e.target.value as Locale)}
                                className="preference-control h-10 w-[3.5rem] shrink-0 rounded-lg border px-2 text-xs font-bold uppercase"
                                aria-label={t('common.language')}
                                title={t(`language.${locale}`)}
                            >
                                {AVAILABLE_LOCALES.map((lang) => (
                                    <option key={lang} value={lang} aria-label={t(`language.${lang}`)}>
                                        {lang.toUpperCase()}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>
                </div>
            </div>

            {/* Main Content */}
            <div className={`workspace-canvas min-h-0 flex-1 overflow-y-auto p-3 sm:p-5 lg:p-8 custom-scrollbar ${pages.length > 0 ? 'workspace-canvas--with-selection' : ''}`}>
                {pages.length === 0 ? (
                    <div className="empty-state box-border flex min-h-full flex-col items-center justify-center p-6 sm:p-10">
                        <div className="empty-state-icon">
                            <Upload className="h-7 w-7" />
                        </div>
                        <h3 className="mb-2 text-center text-lg font-bold sm:text-2xl">{t('editor.dragDropTitle')}</h3>
                        <p className="mb-7 max-w-md text-center text-sm leading-6 text-gray-600 sm:text-base">{t('editor.dragDropDescription')}</p>
                        <label className="btn cursor-pointer" title={t('editor.addFirst')} aria-label={t('editor.addFirst')}>
                            <Plus className="w-5 h-5" />
                            <input
                                type="file"
                                multiple
                                accept=".pdf, .jpg, .jpeg, .png, .docx, .odt"
                                className="hidden"
                                onChange={(e) => {
                                    handleFilesPicked(e.target.files);
                                    e.target.value = '';
                                }}
                            />
                        </label>
                    </div>
                ) : (
                    <DndContext
                        sensors={sensors}
                        collisionDetection={closestCenter}
                        onDragStart={handleDragStart}
                        onDragEnd={handleDragEnd}
                    >
                        <SortableContext
                            items={pages.map(p => p.id)}
                            strategy={rectSortingStrategy}
                        >
                            <div
                                className="grid gap-3 sm:gap-4 lg:gap-6 justify-items-center"
                                style={{
                                    // Make columns dynamic based on thumbnail size
                                    // 180 * scale is the content size. + 24px padding/border approximation.
                                    gridTemplateColumns: `repeat(auto-fill, minmax(${Math.max(120, 180 * scale)}px, 1fr))`
                                }}
                            >
                                {(() => {
                                    const fileIds = [...new Set(pages.map(p => p.fileId))];
                                    return pages.map((page, index) => (
                                        <SortablePage
                                            key={page.id}
                                            id={page.id}
                                            page={page}
                                            file={files[page.fileId]}
                                            onRotate={rotatePage}
                                            onDelete={deletePage}
                                            onClickPage={handlePageClick}
                                            onOpenEditor={handleOpenEditor}
                                            scale={scale}
                                            newPageIndex={index + 1}
                                            documentColor={getDocumentColor(page.fileId, fileIds)}
                                            rotateLabel={t('editor.rotate')}
                                            deleteLabel={t('editor.deletePage')}
                                            isSelected={selectedPageIdSet.has(page.id)}
                                            selectionOrder={selectionOrderMap.get(page.id) ?? null}
                                            onToggleSelection={handleToggleSelection}
                                            selectLabel={t('editor.selectPage')}
                                            deselectLabel={t('editor.deselectPage')}
                                            editLabel={t('editor.editPage')}
                                            finishSettings={{
                                                watermarkText: printOverlayOptions.watermarkText,
                                                headerText: printOverlayOptions.headerText,
                                                footerText: printOverlayOptions.footerText,
                                                includePageNumbers: printOverlayOptions.includePageNumbers,
                                                cropPercent: printOverlayOptions.cropPercent,
                                                marginPercent: printOverlayOptions.marginPercent,
                                            }}
                                            totalPages={pages.length}
                                        />
                                    ));
                                })()}
                            </div>
                        </SortableContext>

                        <DragOverlay>
                            {activeId ? (
                                <div className="opacity-80 rotate-3 cursor-grabbing">
                                    {(() => {
                                        const page = pages.find(p => p.id === activeId);
                                        if (!page) return null;
                                        return (
                                            <div className="bg-white border rounded shadow-xl overflow-hidden">
                                                <div>
                                                    <PdfPreview
                                                        key={page.previewRevision ?? 0}
                                                        pdfDocument={files[page.fileId]?.pdfDoc}
                                                        pageIndex={page.pageIndex}
                                                        width={180 * scale}
                                                        height={180 * scale}
                                                        rotation={page.rotation}
                                                        annotations={page.annotations}
                                                        contentEdits={page.contentEdits}
                                                        annotationCanvasWidth={page.annotationCanvasWidth}
                                                        annotationCanvasHeight={page.annotationCanvasHeight}
                                                        showPageBorder
                                                        finishOptions={{
                                                            watermarkText: printOverlayOptions.watermarkText,
                                                            headerText: printOverlayOptions.headerText,
                                                            footerText: printOverlayOptions.footerText,
                                                            includePageNumbers: printOverlayOptions.includePageNumbers,
                                                            cropPercent: printOverlayOptions.cropPercent,
                                                            marginPercent: printOverlayOptions.marginPercent,
                                                            pageNumber: pages.findIndex(candidate => candidate.id === page.id) + 1,
                                                            totalPages: pages.length,
                                                        }}
                                                    />
                                                </div>
                                            </div>
                                        );
                                    })()}
                                </div>
                            ) : null}
                        </DragOverlay>
                    </DndContext>
                )}
            </div>

            {pages.length > 0 ? (
                <div
                    className="selection-toolbar-dock"
                    role="toolbar"
                    aria-label={t('editor.selectedCount', { count: selectedPageIdsValid.length })}
                >
                    <span
                        className="selection-toolbar-count"
                        role="status"
                        aria-live="polite"
                        title={t('editor.selectedCount', { count: selectedPageIdsValid.length })}
                    >
                        <span>{t('editor.selectedLabel')}</span>
                        <strong>{selectedPageIdsValid.length}/{pages.length}</strong>
                    </span>
                    <div className="selection-toolbar-actions custom-scrollbar">
                        <button
                            type="button"
                            onClick={selectAllPages}
                            disabled={pages.length === 0}
                            className="selection-action-button"
                            title={t('editor.selectAll')}
                            aria-label={t('editor.selectAll')}
                        >
                            <CheckSquare2 aria-hidden="true" className="h-4 w-4" />
                        </button>
                        <button
                            type="button"
                            onClick={clearSelection}
                            disabled={selectedPageIdsValid.length === 0}
                            className="selection-action-button"
                            title={t('editor.clearSelection')}
                            aria-label={t('editor.clearSelection')}
                        >
                            <X aria-hidden="true" className="h-4 w-4" />
                        </button>
                        <button
                            type="button"
                            onClick={handleBatchRotate}
                            disabled={!hasSelectedPages}
                            className="selection-action-button"
                            title={t('editor.rotateSelected')}
                            aria-label={t('editor.rotateSelected')}
                        >
                            <RotateCw aria-hidden="true" className="h-4 w-4" />
                        </button>
                        <button
                            type="button"
                            onClick={handleBatchDuplicate}
                            disabled={!hasSelectedPages}
                            className="selection-action-button"
                            title={t('editor.duplicateSelected')}
                            aria-label={t('editor.duplicateSelected')}
                        >
                            <Copy aria-hidden="true" className="h-4 w-4" />
                        </button>
                        <button
                            type="button"
                            onClick={handleBatchDelete}
                            disabled={!hasSelectedPages}
                            className="selection-action-button selection-action-button--danger"
                            title={t('editor.deleteSelected')}
                            aria-label={t('editor.deleteSelected')}
                        >
                            <Trash2 aria-hidden="true" className="h-4 w-4" />
                        </button>
                        <button
                            type="button"
                            onClick={() => setIsImageExportDialogOpen(true)}
                            disabled={!hasSelectedPages}
                            className="selection-action-button"
                            title={t('editor.exportSelectedAsImages')}
                            aria-label={t('editor.exportSelectedAsImages')}
                        >
                            <Images aria-hidden="true" className="h-4 w-4" />
                        </button>
                        <button
                            type="button"
                            onClick={handleExportSelection}
                            disabled={!hasSelectedPages}
                            className="selection-action-button"
                            title={t('editor.exportSelected')}
                            aria-label={t('editor.exportSelected')}
                        >
                            <Download aria-hidden="true" className="h-4 w-4" />
                        </button>
                    </div>
                </div>
            ) : null}

            <div className="pointer-events-none absolute right-2 sm:right-3 bottom-24 sm:bottom-auto sm:top-1/2 z-20 sm:-translate-y-1/2">
                <div className="floating-tools pointer-events-auto flex flex-col gap-1 p-1">
                    <button
                        onClick={() => setScale(s => Math.max(0.5, s - 0.1))}
                        className={toolbarIconButtonClass}
                        title={t('editor.zoomOut')}
                        aria-label={t('editor.zoomOut')}
                    >
                        <ZoomOut className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => setScale(s => Math.min(2, s + 0.1))}
                        className={toolbarIconButtonClass}
                        title={t('editor.zoomIn')}
                        aria-label={t('editor.zoomIn')}
                    >
                        <ZoomIn className="w-4 h-4" />
                    </button>
                </div>
            </div>
            {/* Page Editor Modal */}
            {(() => {
                const selectedPage = editingPageId ? pages.find(p => p.id === editingPageId) : null;
                if (!selectedPage) return null;
                const selectedPageIndex = pages.findIndex(p => p.id === selectedPage.id);
                const handleNavigateFromEditor = (delta: 1 | -1) => {
                    const nextPage = pages[selectedPageIndex + delta];
                    if (nextPage) setEditingPageId(nextPage.id);
                };
                return (
                    <Suspense
                        fallback={
                            <div className="fixed inset-0 z-40 flex items-center justify-center bg-white/80">
                                <div className="h-8 w-8 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
                            </div>
                        }
                    >
                        <LazyPageEditorModal
                            key={selectedPage.id}
                            isOpen={!!editingPageId}
                            onClose={() => setEditingPageId(null)}
                            onSave={(annotations, contentEdits, canvasSize) => {
                                updatePageAnnotations(selectedPage.id, annotations, contentEdits, canvasSize);
                            }}
                            onRequestNavigate={handleNavigateFromEditor}
                            hasPreviousPage={selectedPageIndex > 0}
                            hasNextPage={selectedPageIndex >= 0 && selectedPageIndex < pages.length - 1}
                            pdfDocument={files[selectedPage.fileId]?.pdfDoc}
                            pageIndex={selectedPage.pageIndex}
                            pageRotation={selectedPage.rotation}
                            initialAnnotations={selectedPage.annotations || []}
                            initialContentEdits={selectedPage.contentEdits || []}
                            initialCanvasWidth={selectedPage.annotationCanvasWidth}
                            initialCanvasHeight={selectedPage.annotationCanvasHeight}
                        />
                    </Suspense>
                );
            })()}

            {isExportDialogOpen ? (
                <div className="dialog-backdrop fixed inset-0 z-40 flex items-center justify-center p-3 sm:p-4">
                    <div
                        ref={exportDialogRef}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="export-dialog-title"
                        aria-describedby="export-dialog-description"
                        tabIndex={-1}
                        className="dialog-surface max-h-[calc(100vh-1.5rem)] w-full max-w-lg overflow-y-auto p-5 custom-scrollbar sm:max-h-[calc(100vh-2rem)] sm:p-6"
                    >
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <h2 id="export-dialog-title" className="text-base font-semibold text-gray-900">
                                    {t('common.export')}
                                </h2>
                                <p id="export-dialog-description" className="mt-1 max-w-md text-sm text-gray-600">
                                    {t('editor.exportDialogHint')}
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={closeExportDialog}
                                className={`${toolbarIconButtonClass} shrink-0`}
                                title={t('common.close')}
                                aria-label={t('common.close')}
                            >
                                <X aria-hidden="true" className="h-4 w-4" />
                            </button>
                        </div>

                        <div className="mt-5 space-y-5">
                            <section>
                                <label htmlFor="export-page-size" className="block text-xs font-semibold text-gray-700">
                                    {t('editor.pageSize')}
                                </label>
                                <select
                                    id="export-page-size"
                                    data-autofocus
                                    value={pageSize}
                                    onChange={(event) => setPageSize(event.target.value as PageSize)}
                                    className="preference-control mt-2 h-11 w-full rounded-lg border px-3 text-sm font-medium"
                                >
                                    <option value="Original">{t('editor.pageSizeOriginal')}</option>
                                    <option value="A4">A4</option>
                                    <option value="A3">A3</option>
                                    <option value="Letter">{t('editor.pageSizeLetter')}</option>
                                    <option value="Legal">{t('editor.pageSizeLegal')}</option>
                                </select>
                            </section>

                            <button
                                type="button"
                                onClick={handleExport}
                                disabled={!canExport}
                                className="primary-action min-h-11 w-full"
                                title={t('editor.exportAll')}
                            >
                                <Download aria-hidden="true" className="h-4 w-4" />
                                {t('editor.exportAll')}
                            </button>

                            <section className="space-y-3 border-t border-gray-200 pt-5">
                                <h3 className="text-sm font-semibold text-gray-900">{t('editor.exportRange')}</h3>
                                <div className="grid grid-cols-2 gap-3">
                                    <label className="space-y-1">
                                        <span className="text-xs font-medium text-gray-600">{t('editor.rangeStart')}</span>
                                        <input
                                            type="number"
                                            min={1}
                                            max={pages.length}
                                            value={rangeStart}
                                            onChange={(event) => setRangeStart(event.target.value)}
                                            className="h-11 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700"
                                        />
                                    </label>
                                    <label className="space-y-1">
                                        <span className="text-xs font-medium text-gray-600">{t('editor.rangeEnd')}</span>
                                        <input
                                            type="number"
                                            min={1}
                                            max={pages.length}
                                            value={rangeEnd}
                                            onChange={(event) => setRangeEnd(event.target.value)}
                                            className="h-11 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700"
                                        />
                                    </label>
                                </div>
                                <button
                                    type="button"
                                    onClick={handleExportRange}
                                    disabled={!canExport}
                                    className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-700 hover:border-gray-300 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                                    title={t('editor.exportRange')}
                                >
                                    <Download aria-hidden="true" className="h-4 w-4" />
                                    {t('editor.exportRange')}
                                </button>
                            </section>

                            <section className="space-y-3 border-t border-gray-200 pt-5">
                                <h3 className="text-sm font-semibold text-gray-900">{t('editor.splitTools')}</h3>
                                <div className="grid gap-2 sm:grid-cols-2">
                                    <button
                                        type="button"
                                        onClick={handleSplitSingle}
                                        disabled={!canExport}
                                        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-700 hover:border-gray-300 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                                        title={t('editor.splitSingle')}
                                    >
                                        <SplitSquareVertical aria-hidden="true" className="h-4 w-4" />
                                        {t('editor.splitSingle')}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleSplitOddEven}
                                        disabled={!canExport}
                                        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-700 hover:border-gray-300 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                                        title={t('editor.splitOddEven')}
                                    >
                                        <SplitSquareVertical aria-hidden="true" className="h-4 w-4" />
                                        {t('editor.splitOddEven')}
                                    </button>
                                </div>
                            </section>

                            <div className="border-t border-gray-200 pt-5">
                                <button
                                    type="button"
                                    onClick={() => {
                                        closeExportDialog();
                                        setIsProtectDialogOpen(true);
                                    }}
                                    disabled={!canExport}
                                    className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-700 hover:border-gray-300 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                                    title={t('editor.protectPdf')}
                                >
                                    <Lock aria-hidden="true" className="h-4 w-4" />
                                    {t('editor.protectPdf')}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}

            {isImageExportDialogOpen ? (
                <div className="dialog-backdrop fixed inset-0 z-40 flex items-center justify-center p-3 sm:p-4">
                    <div
                        ref={imageExportDialogRef}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="image-export-dialog-title"
                        aria-describedby="image-export-dialog-description"
                        tabIndex={-1}
                        className="dialog-surface w-full max-w-md p-5 sm:p-6"
                    >
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <h2 id="image-export-dialog-title" className="text-base font-semibold text-gray-900">
                                    {t('editor.imageExportTitle')}
                                </h2>
                                <p id="image-export-dialog-description" className="mt-1 text-sm leading-6 text-gray-600">
                                    {t('editor.imageExportHint', { count: selectedPageIdsValid.length })}
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={closeImageExportDialog}
                                className={`${toolbarIconButtonClass} shrink-0`}
                                title={t('common.close')}
                                aria-label={t('common.close')}
                            >
                                <X aria-hidden="true" className="h-4 w-4" />
                            </button>
                        </div>

                        <div className="mt-5 space-y-5">
                            <fieldset>
                                <legend className="text-xs font-semibold text-gray-700">
                                    {t('editor.imageFormat')}
                                </legend>
                                <div className="mt-2 grid grid-cols-3 gap-2">
                                    {([
                                        { value: 'jpeg', label: 'JPG' },
                                        { value: 'png', label: 'PNG' },
                                        { value: 'webp', label: 'WebP' },
                                    ] as const).map((format) => (
                                        <button
                                            key={format.value}
                                            type="button"
                                            data-autofocus={format.value === 'jpeg' ? true : undefined}
                                            onClick={() => setImageExportFormat(format.value)}
                                            aria-pressed={imageExportFormat === format.value}
                                            className={`min-h-11 rounded-lg border px-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 ${
                                                imageExportFormat === format.value
                                                    ? 'border-blue-600 bg-blue-50 text-blue-800'
                                                    : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:bg-gray-50'
                                            }`}
                                        >
                                            {format.label}
                                        </button>
                                    ))}
                                </div>
                            </fieldset>

                            <div>
                                <div className="flex items-center justify-between gap-4">
                                    <label htmlFor="image-export-quality" className="text-xs font-semibold text-gray-700">
                                        {t('editor.imageQuality')}
                                    </label>
                                    <output htmlFor="image-export-quality" className="text-sm font-bold tabular-nums text-gray-800">
                                        {imageExportQuality}%
                                    </output>
                                </div>
                                <input
                                    id="image-export-quality"
                                    type="range"
                                    min={30}
                                    max={100}
                                    step={5}
                                    value={imageExportQuality}
                                    onChange={(event) => setImageExportQuality(Number(event.target.value))}
                                    className="mt-2 h-11 w-full accent-blue-600"
                                />
                                <p className="text-xs leading-5 text-gray-500">
                                    {t('editor.imageQualityHint')}
                                </p>
                            </div>

                            <button
                                type="button"
                                onClick={handleExportSelectionAsImages}
                                disabled={!hasSelectedPages}
                                className="primary-action min-h-11 w-full"
                                title={t('editor.convertAndDownloadImages')}
                            >
                                <Download aria-hidden="true" className="h-4 w-4" />
                                {t('editor.convertAndDownloadImages')}
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}

            {isFinishDialogOpen ? (
                <div className="dialog-backdrop fixed inset-0 z-40 flex items-center justify-center p-3 sm:p-4">
                    <div
                        ref={finishDialogRef}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="finish-dialog-title"
                        aria-describedby="finish-dialog-description"
                        tabIndex={-1}
                        className="dialog-surface max-h-[calc(100vh-1.5rem)] w-full max-w-lg overflow-y-auto p-5 custom-scrollbar sm:max-h-[calc(100vh-2rem)] sm:p-6"
                    >
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <h2 id="finish-dialog-title" className="text-base font-semibold text-gray-900">
                                    {t('editor.overlaySettings')}
                                </h2>
                                <p id="finish-dialog-description" className="mt-1 max-w-md text-sm text-gray-600">
                                    {t('editor.overlayDialogHint')}
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={closeFinishDialog}
                                className={`${toolbarIconButtonClass} shrink-0`}
                                title={t('common.close')}
                                aria-label={t('common.close')}
                            >
                                <X aria-hidden="true" className="h-4 w-4" />
                            </button>
                        </div>

                        <div className="mt-5 space-y-4">
                            <label className="block space-y-1">
                                <span className="text-xs font-medium text-gray-600">{t('editor.watermark')}</span>
                                <input
                                    data-autofocus
                                    type="text"
                                    value={printOverlayOptions.watermarkText}
                                    onChange={(event) => setPrintOverlayOptions(prev => ({ ...prev, watermarkText: event.target.value }))}
                                    placeholder={t('editor.watermarkPlaceholder')}
                                    className="h-11 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700"
                                />
                            </label>
                            <label className="block space-y-1">
                                <span className="text-xs font-medium text-gray-600">{t('editor.header')}</span>
                                <input
                                    type="text"
                                    value={printOverlayOptions.headerText}
                                    onChange={(event) => setPrintOverlayOptions(prev => ({ ...prev, headerText: event.target.value }))}
                                    placeholder={t('editor.headerPlaceholder')}
                                    className="h-11 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700"
                                />
                            </label>
                            <label className="block space-y-1">
                                <span className="text-xs font-medium text-gray-600">{t('editor.footer')}</span>
                                <input
                                    type="text"
                                    value={printOverlayOptions.footerText}
                                    onChange={(event) => setPrintOverlayOptions(prev => ({ ...prev, footerText: event.target.value }))}
                                    placeholder={t('editor.footerPlaceholder')}
                                    className="h-11 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700"
                                />
                            </label>
                            <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700">
                                <input
                                    type="checkbox"
                                    checked={printOverlayOptions.includePageNumbers}
                                    onChange={(event) => setPrintOverlayOptions(prev => ({ ...prev, includePageNumbers: event.target.checked }))}
                                    className="h-4 w-4 rounded border-gray-300"
                                />
                                {t('editor.pageNumbers')}
                            </label>
                            <label className="block space-y-2 border-t border-gray-200 pt-4">
                                <span className="flex items-center justify-between gap-3">
                                    <span className="text-xs font-medium text-gray-600">{t('editor.crop')}</span>
                                    <span className="text-xs font-semibold tabular-nums text-gray-700">{printOverlayOptions.cropPercent}%</span>
                                </span>
                                <input
                                    type="range"
                                    min={0}
                                    max={20}
                                    step={1}
                                    value={printOverlayOptions.cropPercent}
                                    onChange={(event) => setPrintOverlayOptions(prev => ({ ...prev, cropPercent: Number(event.target.value) }))}
                                    className="w-full"
                                    aria-label={t('editor.crop')}
                                />
                            </label>
                            <label className="block space-y-2">
                                <span className="flex items-center justify-between gap-3">
                                    <span className="text-xs font-medium text-gray-600">{t('editor.margin')}</span>
                                    <span className="text-xs font-semibold tabular-nums text-gray-700">{printOverlayOptions.marginPercent}%</span>
                                </span>
                                <input
                                    type="range"
                                    min={0}
                                    max={20}
                                    step={1}
                                    value={printOverlayOptions.marginPercent}
                                    onChange={(event) => setPrintOverlayOptions(prev => ({ ...prev, marginPercent: Number(event.target.value) }))}
                                    className="w-full"
                                    aria-label={t('editor.margin')}
                                />
                            </label>
                        </div>

                        <div className="mt-5 border-t border-gray-200 pt-5">
                            <button
                                type="button"
                                onClick={closeFinishDialog}
                                className="primary-action min-h-11 w-full"
                                title={t('common.close')}
                            >
                                <Check aria-hidden="true" className="h-4 w-4" />
                                {t('common.close')}
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}
            {isProtectDialogOpen ? (
                <div className="dialog-backdrop fixed inset-0 z-40 flex items-center justify-center p-4">
                    <div
                        ref={protectDialogRef}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="protect-dialog-title"
                        aria-describedby="protect-dialog-description"
                        tabIndex={-1}
                        className="dialog-surface w-full max-w-sm p-5"
                    >
                        <h2 id="protect-dialog-title" className="mb-1 text-sm font-semibold text-gray-900">{t('editor.protectPdf')}</h2>
                        <p id="protect-dialog-description" className="mb-3 text-xs text-gray-600">{t('editor.protectHint')}</p>
                        <div className="space-y-2">
                            <input
                                id="protect-password"
                                data-autofocus
                                type="password"
                                autoComplete="new-password"
                                value={protectPassword}
                                onChange={(e) => setProtectPassword(e.target.value)}
                                className="h-9 w-full rounded-md border border-gray-300 px-2.5 text-sm text-gray-800 focus:border-gray-400 focus:outline-none"
                                placeholder={t('editor.password')}
                                aria-label={t('editor.password')}
                            />
                            <input
                                id="protect-password-confirm"
                                type="password"
                                autoComplete="new-password"
                                value={protectPasswordConfirm}
                                onChange={(e) => setProtectPasswordConfirm(e.target.value)}
                                className="h-9 w-full rounded-md border border-gray-300 px-2.5 text-sm text-gray-800 focus:border-gray-400 focus:outline-none"
                                placeholder={t('editor.confirmPassword')}
                                aria-label={t('editor.confirmPassword')}
                            />
                        </div>
                        <div className="mt-4 flex justify-end gap-2">
                            <button
                                type="button"
                                onClick={closeProtectDialog}
                                className={toolbarIconButtonClass}
                                title={t('common.cancel')}
                                aria-label={t('common.cancel')}
                            >
                                <X className="h-4 w-4" />
                            </button>
                            <button
                                type="button"
                                onClick={handleProtectExport}
                                disabled={isProcessing || !protectPassword.trim() || !protectPasswordConfirm.trim()}
                                className={toolbarIconButtonClass}
                                title={t('common.save')}
                                aria-label={t('common.save')}
                            >
                                <Check className="h-4 w-4" />
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}

            {isUnlockDialogOpen ? (
                <div className="dialog-backdrop fixed inset-0 z-40 flex items-center justify-center p-4">
                    <div
                        ref={unlockDialogRef}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="unlock-dialog-title"
                        aria-describedby="unlock-dialog-description"
                        tabIndex={-1}
                        className="dialog-surface w-full max-w-sm p-5"
                    >
                        <h2 id="unlock-dialog-title" className="mb-1 text-sm font-semibold text-gray-900">{t('editor.unlockPdf')}</h2>
                        <p id="unlock-dialog-description" className="mb-3 text-xs text-gray-600">{t('editor.unlockHint')}</p>
                        <div className="mb-2 flex min-h-11 items-center gap-2 rounded-md border border-gray-300 px-3 py-2">
                            <LockOpen aria-hidden="true" className="h-4 w-4 shrink-0 text-gray-500" />
                            <span className="truncate text-xs text-gray-700">
                                {unlockFile?.name ?? t('editor.noFileSelected')}
                            </span>
                        </div>
                        <input
                            id="unlock-password"
                            data-autofocus
                            type="password"
                            autoComplete="current-password"
                            value={unlockPassword}
                            onChange={(e) => setUnlockPassword(e.target.value)}
                            className="h-9 w-full rounded-md border border-gray-300 px-2.5 text-sm text-gray-800 focus:border-gray-400 focus:outline-none"
                            placeholder={t('editor.password')}
                            aria-label={t('editor.password')}
                        />
                        <div className="mt-4 flex justify-end gap-2">
                            <button
                                type="button"
                                onClick={closeUnlockDialog}
                                className={toolbarIconButtonClass}
                                title={t('common.cancel')}
                                aria-label={t('common.cancel')}
                            >
                                <X className="h-4 w-4" />
                            </button>
                            <button
                                type="button"
                                onClick={handleUnlockImport}
                                disabled={isProcessing || !unlockFile || !unlockPassword.trim()}
                                className={toolbarIconButtonClass}
                                title={t('editor.unlockPdf')}
                                aria-label={t('editor.unlockPdf')}
                            >
                                <LockOpen aria-hidden="true" className="h-4 w-4" />
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}

            {isClearAllDialogOpen ? (
                <div className="dialog-backdrop fixed inset-0 z-40 flex items-center justify-center p-4">
                    <div
                        ref={clearAllDialogRef}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="clear-all-dialog-title"
                        aria-describedby="clear-all-dialog-description"
                        tabIndex={-1}
                        className="dialog-surface w-full max-w-sm p-5"
                    >
                        <h2 id="clear-all-dialog-title" className="mb-1 text-sm font-semibold text-gray-900">{t('editor.clearAllTitle')}</h2>
                        <p id="clear-all-dialog-description" className="mb-3 text-xs text-gray-600">{t('editor.clearAllDescription')}</p>
                        <div className="mt-4 flex justify-end gap-2">
                            <button
                                type="button"
                                autoFocus
                                onClick={closeClearAllDialog}
                                className="inline-flex h-9 items-center justify-center rounded-md border border-gray-200 bg-white px-3 text-xs font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                                title={t('common.cancel')}
                                aria-label={t('common.cancel')}
                            >
                                {t('common.cancel')}
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    closeClearAllDialog();
                                    clearSelection();
                                    clearAll();
                                }}
                                disabled={isProcessing}
                                className="inline-flex h-9 items-center justify-center rounded-md border border-red-300 bg-red-600 px-3 text-xs font-medium text-white hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 disabled:opacity-40"
                                title={t('common.clear')}
                                aria-label={t('common.clear')}
                            >
                                {t('common.clear')}
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    );
};


