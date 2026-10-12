import { readBrowserPreference, writeBrowserPreference, removeBrowserPreference } from '../utils/browserPreferences';
import { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { usePdfEditor, type EditorFile, type EditorPage, type ImageExportOptions } from '../hooks/usePdfEditor';
import { PdfPreview, type PdfPreviewFinishOptions } from '../components/PdfPreview';
import { DeferredPdfPreview } from '../components/DeferredPdfPreview';
import { SessionAlert, SessionPill } from '../components/SessionStatus';
import { StartScreen } from '../components/StartScreen';
import { ZoomControl } from '../components/ZoomControl';
import { DisclosureMenu } from '../components/DisclosureMenu';
import { OperationStatus } from '../components/OperationStatus';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragOverlay } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { RotateCw, Trash2, Download, Plus, Undo, Redo, FileText, X, Copy, CheckSquare2, SlidersHorizontal, Pencil, Images, MoreHorizontal } from 'lucide-react';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { useI18n } from '../i18n';
import { AVAILABLE_LOCALES, type Locale } from '../i18n/locales';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { contentEditErrorMessageKey } from '../features/content-editor/errorMessages';
import { useLaunchedFiles } from '../hooks/useLaunchedFiles';
import { useMediaQuery, useViewportWidth } from '../hooks/useMediaQuery';
import { MIN_ZOOM, nextZoomStep } from '../utils/zoomSteps';
import type { ImageCompressionResult } from '../features/export/compressImages';
import { ClearAllDialog, ExportDialog, FinishDialog, ImageExportDialog, ProtectDialog, UnlockDialog } from './EditorDialogs';
import {
    getImageExportQualityValue,
    type ImageExportQualityPreset,
} from '../utils/imageExport';

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

const MAX_GRID_ZOOM = 2;

const getInitialScale = () => {
    if (typeof window === 'undefined') {
        return 1;
    }
    const savedScale = Number(readBrowserPreference('pageforge.editor.scale') ?? '1');
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
    thumbnailSize: number;
    newPageIndex: number;
    documentColor: string;
    isSelected: boolean;
    selectionOrder: number | null;
    onToggleSelection: (pageId: string, shouldSelect: boolean) => void;
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
    thumbnailSize,
    newPageIndex,
    documentColor,
    isSelected,
    selectionOrder,
    onToggleSelection,
    finishSettings,
    totalPages,
}: SortablePageProps) {
    const { t } = useI18n();
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
    const fileName = file?.file.name ?? '';
    const positionLabel = t('editor.positionBadge', { position: newPageIndex });
    const sourceLabel = t('editor.sourcePageBadge', { page: page.pageIndex });
    const selectionLabel = isSelected ? t('editor.deselectPage') : t('editor.selectPage');

    return (
        <div ref={setNodeRef} style={style} className="page-item">
            <div
                className={`document-card ${isSelected ? 'document-card--selected' : ''}`}
                {...attributes}
                {...listeners}
                onClick={(event) => onClickPage(id, event)}
            >
                <div className="page-thumb">
                    <DeferredPdfPreview
                        key={page.previewRevision ?? 0}
                        pdfDocument={file?.pdfDoc}
                        pageIndex={page.pageIndex}
                        width={thumbnailSize}
                        height={thumbnailSize}
                        rotation={page.rotation}
                        className="pointer-events-none"
                        annotations={page.annotations}
                        contentEdits={page.contentEdits}
                        annotationCanvasWidth={page.annotationCanvasWidth}
                        annotationCanvasHeight={page.annotationCanvasHeight}
                        formValues={page.formValues}
                        showPageBorder
                        finishOptions={{
                            ...finishSettings,
                            pageNumber: newPageIndex,
                            totalPages,
                        }}
                    />
                </div>
                <div className="page-caption">
                    {/* Position in the exported document, then the file and page it comes from. */}
                    <span className="page-caption-position" title={positionLabel}>
                        <span aria-hidden="true">{newPageIndex}</span>
                        <span className="sr-only">{positionLabel}</span>
                    </span>
                    <span className="file-dot" style={{ backgroundColor: documentColor }} aria-hidden="true" />
                    <span className="page-caption-source" title={`${fileName} · ${sourceLabel}`}>
                        {t('editor.sourceCaption', { file: fileName, page: page.pageIndex })}
                    </span>
                </div>
            </div>

            <button
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                    event.stopPropagation();
                    onToggleSelection(id, !isSelected);
                }}
                className={`page-tick ${isSelected ? 'page-tick--selected' : ''}`}
                title={selectionLabel}
                aria-label={selectionLabel}
            >
                {selectionOrder ?? ''}
            </button>

            {/* Revealed on hover or focus; touch screens get the menu below instead. */}
            <div className="page-actions">
                <button
                    type="button"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                        event.stopPropagation();
                        onOpenEditor(id);
                    }}
                    className="page-action"
                    title={t('editor.editPage')}
                    aria-label={t('editor.editPage')}
                >
                    <Pencil aria-hidden="true" className="h-4 w-4" />
                </button>
                <button
                    type="button"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => { event.stopPropagation(); onRotate(id); }}
                    className="page-action"
                    title={t('editor.rotate')}
                    aria-label={t('editor.rotate')}
                >
                    <RotateCw aria-hidden="true" className="h-4 w-4" />
                </button>
                <button
                    type="button"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => { event.stopPropagation(); onDelete(id); }}
                    className="page-action page-action--danger"
                    title={t('editor.deletePage')}
                    aria-label={t('editor.deletePage')}
                >
                    <Trash2 aria-hidden="true" className="h-4 w-4" />
                </button>
            </div>
            <DisclosureMenu
                label={t('editor.pageActions', { page: newPageIndex })}
                icon={<span className="page-more-icon"><MoreHorizontal aria-hidden="true" className="h-4 w-4" /></span>}
                className="page-more-anchor"
                buttonClassName="page-more"
                panelClassName="page-menu"
            >
                {(close) => (
                    <>
                        <button type="button" className="menu-item" onClick={() => { close(); onOpenEditor(id); }}>
                            <Pencil aria-hidden="true" className="h-4 w-4" />
                            {t('editor.editPage')}
                        </button>
                        <button type="button" className="menu-item" onClick={() => { close(); onRotate(id); }}>
                            <RotateCw aria-hidden="true" className="h-4 w-4" />
                            {t('editor.rotate')}
                        </button>
                        <button type="button" className="menu-item menu-item--danger" onClick={() => { close(); onDelete(id); }}>
                            <Trash2 aria-hidden="true" className="h-4 w-4" />
                            {t('editor.deletePage')}
                        </button>
                    </>
                )}
            </DisclosureMenu>
        </div>
    );
});

interface PdfEditorProps {
    onOpenInfo: () => void;
}

export const PdfEditor = ({ onOpenInfo }: PdfEditorProps) => {
    const { locale, setLocale, t } = useI18n();
    const {
        files,
        pages,
        isProcessing,
        notification,
        dismissNotification,
        sessionSaveStatus,
        hasUnsavedChanges,
        retrySessionSave,
        flushSession,
        operation,
        cancelOperation,
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
        updatePageAnnotations,
        isSessionReady,
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
    const [imageExportQualityPreset, setImageExportQualityPreset] = useState<ImageExportQualityPreset>('balanced');
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

    const finishSettings = useMemo(() => ({
        watermarkText: printOverlayOptions.watermarkText,
        headerText: printOverlayOptions.headerText,
        footerText: printOverlayOptions.footerText,
        includePageNumbers: printOverlayOptions.includePageNumbers,
        cropPercent: printOverlayOptions.cropPercent,
        marginPercent: printOverlayOptions.marginPercent,
    }), [printOverlayOptions]);
    const fileIds = useMemo(() => [...new Set(pages.map(page => page.fileId))], [pages]);
    const pageCountByFile = useMemo(() => {
        const counts = new Map<string, number>();
        for (const page of pages) counts.set(page.fileId, (counts.get(page.fileId) ?? 0) + 1);
        return counts;
    }, [pages]);
    const exportLabels = useMemo(() => ({
        failed: t('editor.exportFailed'),
        downloadPrefix: t('editor.downloadPrefix'),
        editedSuffix: t('editor.editedFileSuffix'),
        missingPagesWarning: t('editor.missingPagesWarning'),
        success: t('editor.exportSuccess'),
        contentEditFailed: (pageNumber: number, code?: string) =>
            t('editor.contentEditPageFailed', { page: pageNumber, reason: t(contentEditErrorMessageKey(code)) }),
        formFillFailed: (fieldName: string) => t('editor.formFillFailed', { field: fieldName }),
        compressionResult: (result: ImageCompressionResult) => {
            if (result.compressedImages === 0) return t('editor.compressionNothing');
            const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
            const formatSize = (bytes: number) => bytes < 1024 * 1024
                ? `${number.format(Math.max(1, Math.round(bytes / 1024)))} KB`
                : `${number.format(bytes / (1024 * 1024))} MB`;
            return t('editor.compressionResult', { before: formatSize(result.bytesBefore), after: formatSize(result.bytesAfter) });
        },
    }), [t, locale]);

    const hasPages = pages.length > 0;
    const sessionFailed = sessionSaveStatus === 'error' || sessionSaveStatus === 'conflict';
    const isNarrow = useMediaQuery('(max-width: 639px)');
    const viewportWidth = useViewportWidth();
    // Phones show two columns: half the width, minus the gutters and the card padding.
    const thumbnailSize = isNarrow ? Math.max(96, Math.floor((viewportWidth - 44) / 2) - 24) : Math.round(180 * scale);
    const selectedCountLabel = selectedPageIdsValid.length === 1
        ? t('editor.selectedCountOne')
        : t('editor.selectedCount', { count: selectedPageIdsValid.length });
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
    const renderOverlayBadge = (className: string) => activeOverlayCount > 0 ? (
        <span className={`min-w-4 rounded-full bg-blue-600 px-1 text-center text-[10px] font-bold leading-4 text-white ${className}`}>
            {activeOverlayCount}
        </span>
    ) : null;
    const renderLanguageSelect = (id: string) => (
        <select
            id={id}
            value={locale}
            onChange={(e) => setLocale(e.target.value as Locale)}
            className="preference-control w-[4.25rem] shrink-0 px-2 uppercase"
            title={t(`language.${locale}`)}
        >
            {AVAILABLE_LOCALES.map((lang) => (
                <option key={lang} value={lang} aria-label={t(`language.${lang}`)}>
                    {lang.toUpperCase()}
                </option>
            ))}
        </select>
    );

    useEffect(() => {
        writeBrowserPreference('pageforge.editor.scale', scale.toString());
    }, [scale]);

    useEffect(() => {
        writeBrowserPreference('pageforge.editor.page-size', pageSize);
    }, [pageSize]);

    useEffect(() => {
        removeBrowserPreference('pageforge.editor.export-panel-open');
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
            if (operation || hasUnsavedChanges) {
                event.preventDefault();
                event.returnValue = '';
                void flushSession();
            }
        };
        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => window.removeEventListener('beforeunload', handleBeforeUnload);
    }, [operation, hasUnsavedChanges, flushSession]);

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
        pageLimit: t('editor.importPageLimit'),
        imageTooLarge: t('editor.importImageTooLarge'),
        unreadable: t('editor.importUnreadable'),
        officeRasterized: t('editor.importOfficeRasterized'),
        success: t('editor.importSuccess'),
        onPasswordRequired: openUnlockDialogForFile,
    }), [openUnlockDialogForFile, t]);

    // Files opened with the installed app (file handler) or shared to it (share target).
    useLaunchedFiles(isSessionReady, useCallback((launched: File[]) => addFiles(launched, getImportLabels()), [addFiles, getImportLabels]));

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

    const openExportDialog = useCallback(() => {
        // The range starts as the whole document.
        setRangeStart('1');
        setRangeEnd(String(Math.max(1, pages.length)));
        setIsExportDialogOpen(true);
    }, [pages.length]);

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
        exportPdf(exportLabels);
    }, [
        canExport,
        closeExportDialog,
        exportPdf,
        exportLabels,
    ]);

    const handleExportSelection = useCallback(() => {
        if (selectedPageIdsValid.length === 0 || isProcessing) {
            return;
        }

        exportPdf(exportLabels, selectedPageIdsValid);
    }, [selectedPageIdsValid, isProcessing, exportPdf, exportLabels]);

    const handleExportSelectionAsImages = useCallback(async () => {
        if (selectedPageIdsValid.length === 0 || isProcessing) {
            return;
        }

        closeImageExportDialog();
        await exportPagesAsImages({
            format: imageExportFormat,
            quality: getImageExportQualityValue(imageExportQualityPreset),
        }, {
            failed: t('editor.imageExportFailed'),
            limitExceeded: t('editor.imageExportLimitExceeded'),
            missingPagesWarning: t('editor.missingPagesWarning'),
            pagePrefix: t('editor.imagePagePrefix'),
            downloadPrefix: t('editor.imageDownloadPrefix'),
            imagesSuffix: t('editor.imagesFileSuffix'),
            success: t('editor.imageExportSuccess'),
            contentEditFailed: exportLabels.contentEditFailed,
            formFillFailed: exportLabels.formFillFailed,
        }, selectedPageIdsValid);
    }, [
        selectedPageIdsValid,
        isProcessing,
        closeImageExportDialog,
        exportPagesAsImages,
        imageExportFormat,
        imageExportQualityPreset,
        exportLabels,
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
        await exportPageRange(start, end, exportLabels);
    }, [closeExportDialog, rangeStart, rangeEnd, pages.length, exportPageRange, exportLabels, t]);

    const handleSplit = useCallback(async (mode: 'single' | 'odd-even') => {
        closeExportDialog();
        await splitPdf(mode, {
            ...exportLabels,
            splitDownloadPrefix: t('editor.splitDownloadPrefix'),
            splitSuffix: t('editor.splitFileSuffix'),
            oddSuffix: t('editor.splitOddFile'),
            evenSuffix: t('editor.splitEvenFile'),
            pageSuffix: t('editor.splitPageFile'),
        });
    }, [closeExportDialog, splitPdf, exportLabels, t]);

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

        // Spaces are part of the password, so both entries must match exactly.
        if (protectPassword !== protectPasswordConfirm) {
            setUiError(t('editor.passwordMismatch'));
            return;
        }

        const success = await exportProtectedPdf(protectPassword, {
            ...exportLabels,
            failed: t('editor.protectFailed'),
            invalidPassword: t('editor.invalidPassword'),
            downloadPrefix: t('editor.protectedDownloadPrefix'),
            protectedSuffix: t('editor.protectedFileSuffix'),
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
        exportLabels,
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
                className="pointer-events-none fixed left-1/2 top-[6.5rem] z-[100] w-[min(92vw,36rem)] -translate-x-1/2 sm:top-3"
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
            {operation ? <OperationStatus operation={operation} onCancel={cancelOperation} /> : null}
            <input
                ref={addFilesInputRef}
                type="file"
                disabled={isProcessing}
                multiple
                accept=".pdf, .jpg, .jpeg, .png, .docx, .odt"
                className="hidden"
                onChange={(e) => {
                    handleFilesPicked(e.target.files);
                    e.target.value = '';
                }}
            />
            <header className="workspace-header app-header">
                <div className="app-header-start">
                    <button
                        type="button"
                        onClick={onOpenInfo}
                        className="brand-button"
                        title={t('welcome.open')}
                        aria-label={t('welcome.open')}
                    >
                        <span className="brand-mark">
                            <FileText aria-hidden="true" className="h-5 w-5" />
                        </span>
                        <span className={`brand-name ${hasPages ? 'hidden md:inline' : ''}`}>{t('app.title')}</span>
                    </button>
                    {sessionFailed ? null : <SessionPill status={sessionSaveStatus} onOpenSettings={onOpenInfo} />}
                </div>
                <div className="app-header-actions">
                    {hasPages ? (
                        <>
                            <div role="group" aria-label={t('editor.history')} className="flex items-center gap-1">
                                <button
                                    type="button"
                                    onClick={undo}
                                    disabled={!canUndo || isProcessing}
                                    className="toolbar-button toolbar-button--ghost"
                                    title={t('editor.undo')}
                                    aria-label={t('editor.undo')}
                                >
                                    <Undo aria-hidden="true" className="h-4 w-4" />
                                </button>
                                <button
                                    type="button"
                                    onClick={redo}
                                    disabled={!canRedo || isProcessing}
                                    className="toolbar-button toolbar-button--ghost"
                                    title={t('editor.redo')}
                                    aria-label={t('editor.redo')}
                                >
                                    <Redo aria-hidden="true" className="h-4 w-4" />
                                </button>
                            </div>
                            <span className="header-divider desktop-only" aria-hidden="true" />
                            <button
                                type="button"
                                onClick={() => setIsFinishDialogOpen(true)}
                                className="toolbar-button toolbar-button--labelled desktop-only relative"
                                title={t('editor.overlaySettings')}
                                aria-label={t('editor.overlaySettings')}
                            >
                                <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
                                <span className="header-label-lg">{t('editor.overlaySettings')}</span>
                                {renderOverlayBadge('absolute -right-1 -top-1')}
                            </button>
                            <button
                                type="button"
                                onClick={triggerAddFiles}
                                disabled={isProcessing}
                                className="toolbar-button toolbar-button--labelled"
                                title={t('editor.addFiles')}
                                aria-label={t('editor.addFiles')}
                            >
                                <Plus aria-hidden="true" className="h-4 w-4" />
                                <span className="header-label-lg">{t('common.add')}</span>
                            </button>
                            <button
                                type="button"
                                onClick={openExportDialog}
                                disabled={isProcessing}
                                className="primary-action"
                                title={t('common.export')}
                                aria-label={t('common.export')}
                            >
                                <Download aria-hidden="true" className="h-4 w-4" />
                                <span className="header-label-sm">{t('common.export')}</span>
                            </button>
                        </>
                    ) : null}
                    <div className={hasPages ? 'desktop-only' : ''}>
                        <label htmlFor="language-select" className="sr-only">{t('common.language')}</label>
                        {renderLanguageSelect('language-select')}
                    </div>
                    {hasPages ? (
                        <DisclosureMenu
                            label={t('editor.moreOptions')}
                            icon={<MoreHorizontal aria-hidden="true" className="h-5 w-5" />}
                            className="mobile-only"
                            buttonClassName="toolbar-button toolbar-button--ghost"
                        >
                            {(close) => (
                                <>
                                    <button type="button" className="menu-item" onClick={() => { close(); setIsFinishDialogOpen(true); }}>
                                        <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
                                        <span className="flex-1">{t('editor.overlaySettings')}</span>
                                        {renderOverlayBadge('')}
                                    </button>
                                    <div className="menu-field">
                                        <label htmlFor="language-select-menu">{t('common.language')}</label>
                                        {renderLanguageSelect('language-select-menu')}
                                    </div>
                                    <div className="menu-separator" />
                                    <button
                                        type="button"
                                        className="menu-item menu-item--danger"
                                        disabled={isProcessing}
                                        onClick={() => { close(); setIsClearAllDialogOpen(true); }}
                                    >
                                        <Trash2 aria-hidden="true" className="h-4 w-4" />
                                        {t('common.clear')}
                                    </button>
                                </>
                            )}
                        </DisclosureMenu>
                    ) : null}
                </div>
            </header>
            {sessionFailed ? <SessionAlert status={sessionSaveStatus} onRetry={retrySessionSave} /> : null}

            {hasPages ? (
                <div className="doc-bar">
                    <ul className="file-chips" aria-label={t('editor.documentFiles')}>
                        {fileIds.map(fileId => {
                            const count = pageCountByFile.get(fileId) ?? 0;
                            const fileName = files[fileId]?.file.name ?? '';
                            return (
                                <li key={fileId} className="file-chip" title={fileName}>
                                    <span className="file-dot" style={{ backgroundColor: getDocumentColor(fileId, fileIds) }} aria-hidden="true" />
                                    <span className="file-chip-name">{fileName}</span>
                                    <span className="file-chip-count">{count === 1 ? t('editor.filePagesOne') : t('editor.filePages', { count })}</span>
                                </li>
                            );
                        })}
                    </ul>
                    <div className="doc-bar-tools">
                        <span className="doc-bar-total">
                            {pages.length === 1 ? t('editor.totalPagesOne') : t('editor.totalPages', { count: pages.length })}
                        </span>
                        <ZoomControl
                            zoom={scale}
                            onZoomOut={() => setScale(current => nextZoomStep(current, -1, MAX_GRID_ZOOM))}
                            onZoomIn={() => setScale(current => nextZoomStep(current, 1, MAX_GRID_ZOOM))}
                            canZoomOut={scale > MIN_ZOOM + 0.001}
                            canZoomIn={scale < MAX_GRID_ZOOM - 0.001}
                        />
                        <button
                            type="button"
                            onClick={() => setIsClearAllDialogOpen(true)}
                            disabled={isProcessing}
                            className="text-button text-button--danger"
                        >
                            <Trash2 aria-hidden="true" className="h-4 w-4" />
                            {t('common.clear')}
                        </button>
                    </div>
                </div>
            ) : null}

            <div className="workspace-canvas min-h-0 flex-1 overflow-y-auto custom-scrollbar">
                {hasPages ? (
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
                                className="page-grid"
                                style={{
                                    // Phones get two columns; wider screens fit as many as the zoom allows.
                                    gridTemplateColumns: isNarrow
                                        ? 'repeat(2, minmax(0, 1fr))'
                                        : `repeat(auto-fill, minmax(${thumbnailSize + 24}px, 1fr))`,
                                }}
                            >
                                {pages.map((page, index) => (
                                    <SortablePage
                                        key={page.id}
                                        id={page.id}
                                        page={page}
                                        file={files[page.fileId]}
                                        onRotate={rotatePage}
                                        onDelete={deletePage}
                                        onClickPage={handlePageClick}
                                        onOpenEditor={handleOpenEditor}
                                        thumbnailSize={thumbnailSize}
                                        newPageIndex={index + 1}
                                        documentColor={getDocumentColor(page.fileId, fileIds)}
                                        isSelected={selectedPageIdSet.has(page.id)}
                                        selectionOrder={selectionOrderMap.get(page.id) ?? null}
                                        onToggleSelection={handleToggleSelection}
                                        finishSettings={finishSettings}
                                        totalPages={pages.length}
                                    />
                                ))}
                            </div>
                        </SortableContext>

                        <DragOverlay>
                            {activeId ? (
                                <div className="opacity-80 rotate-3 cursor-grabbing">
                                    {(() => {
                                        const page = pages.find(p => p.id === activeId);
                                        if (!page) return null;
                                        return (
                                            <div className="document-card">
                                                <div className="page-thumb">
                                                    <PdfPreview
                                                        key={page.previewRevision ?? 0}
                                                        pdfDocument={files[page.fileId]?.pdfDoc}
                                                        pageIndex={page.pageIndex}
                                                        width={thumbnailSize}
                                                        height={thumbnailSize}
                                                        rotation={page.rotation}
                                                        annotations={page.annotations}
                                                        contentEdits={page.contentEdits}
                                                        annotationCanvasWidth={page.annotationCanvasWidth}
                                                        annotationCanvasHeight={page.annotationCanvasHeight}
                                                        formValues={page.formValues}
                                                        showPageBorder
                                                        finishOptions={{
                                                            ...finishSettings,
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
                ) : (
                    <StartScreen disabled={isProcessing} onAddFiles={triggerAddFiles} />
                )}
            </div>

            {hasPages && selectedPageIdsValid.length > 0 ? (
                <div className="selection-dock" role="toolbar" aria-label={selectedCountLabel}>
                    <div className="selection-dock-head">
                        <span className="selection-dock-count" role="status" aria-live="polite">{selectedCountLabel}</span>
                        <button type="button" onClick={selectAllPages} className="text-button text-button--accent selection-dock-select-all">
                            {t('editor.selectAll')}
                        </button>
                        <button
                            type="button"
                            onClick={clearSelection}
                            className="toolbar-button toolbar-button--ghost selection-dock-clear"
                            title={t('editor.clearSelection')}
                            aria-label={t('editor.clearSelection')}
                        >
                            <X aria-hidden="true" className="h-4 w-4" />
                        </button>
                    </div>
                    <div className="selection-dock-actions">
                        <button
                            type="button"
                            onClick={handleBatchRotate}
                            disabled={!hasSelectedPages}
                            className="dock-button"
                            title={t('editor.rotateSelected')}
                            aria-label={t('editor.rotateSelected')}
                        >
                            <RotateCw aria-hidden="true" className="h-5 w-5" />
                            {t('editor.rotate')}
                        </button>
                        <button
                            type="button"
                            onClick={handleBatchDuplicate}
                            disabled={!hasSelectedPages}
                            className="dock-button"
                            title={t('editor.duplicateSelected')}
                            aria-label={t('editor.duplicateSelected')}
                        >
                            <Copy aria-hidden="true" className="h-5 w-5" />
                            {t('editor.duplicate')}
                        </button>
                        <button
                            type="button"
                            onClick={() => setIsImageExportDialogOpen(true)}
                            disabled={!hasSelectedPages}
                            className="dock-button"
                            title={t('editor.exportSelectedAsImages')}
                            aria-label={t('editor.exportSelectedAsImages')}
                        >
                            <Images aria-hidden="true" className="h-5 w-5" />
                            {t('editor.imagesShort')}
                        </button>
                        <button
                            type="button"
                            onClick={handleExportSelection}
                            disabled={!hasSelectedPages}
                            className="dock-button"
                            title={t('editor.exportSelected')}
                            aria-label={t('editor.exportSelected')}
                        >
                            <Download aria-hidden="true" className="h-5 w-5" />
                            {t('common.export')}
                        </button>
                        <button
                            type="button"
                            onClick={handleBatchDelete}
                            disabled={!hasSelectedPages}
                            className="dock-button dock-button--danger"
                            title={t('editor.deleteSelected')}
                            aria-label={t('editor.deleteSelected')}
                        >
                            <Trash2 aria-hidden="true" className="h-5 w-5" />
                            {t('common.delete')}
                        </button>
                    </div>
                    <span className="selection-dock-divider" aria-hidden="true" />
                </div>
            ) : hasPages ? (
                <div className="selection-hint">
                    <span>
                        <span className="[@media(hover:none)]:hidden">{t('editor.selectionHint')}</span>
                        <span className="hidden [@media(hover:none)]:inline">{t('editor.selectionHintTouch')}</span>
                    </span>
                    <button type="button" onClick={selectAllPages} className="toolbar-button toolbar-button--labelled h-9 shrink-0">
                        <CheckSquare2 aria-hidden="true" className="h-4 w-4" />
                        {t('editor.selectAll')}
                    </button>
                </div>
            ) : null}

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
                            onSave={(annotations, contentEdits, canvasSize, formValues) => {
                                updatePageAnnotations(selectedPage.id, annotations, contentEdits, canvasSize, formValues);
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
                            initialFormValues={selectedPage.formValues}
                            pagePosition={selectedPageIndex + 1}
                            pageCount={pages.length}
                        />
                    </Suspense>
                );
            })()}

            {isExportDialogOpen ? (
                <ExportDialog
                    dialogRef={exportDialogRef}
                    onClose={closeExportDialog}
                    pageSize={pageSize}
                    onPageSizeChange={setPageSize}
                    imageCompression={imageCompression}
                    onImageCompressionChange={setImageCompression}
                    canExport={canExport}
                    onExportAll={handleExport}
                    pageCount={pages.length}
                    rangeStart={rangeStart}
                    rangeEnd={rangeEnd}
                    onRangeStartChange={setRangeStart}
                    onRangeEndChange={setRangeEnd}
                    onExportRange={handleExportRange}
                    selectedCount={selectedPageIdsValid.length}
                    onExportSelection={() => {
                        closeExportDialog();
                        handleExportSelection();
                    }}
                    onSplit={handleSplit}
                    onProtect={() => {
                        closeExportDialog();
                        setIsProtectDialogOpen(true);
                    }}
                    onOpenFinish={() => {
                        closeExportDialog();
                        setIsFinishDialogOpen(true);
                    }}
                />
            ) : null}

            {isImageExportDialogOpen ? (
                <ImageExportDialog
                    dialogRef={imageExportDialogRef}
                    onClose={closeImageExportDialog}
                    selectedCount={selectedPageIdsValid.length}
                    selectedFormat={imageExportFormat}
                    onFormatChange={setImageExportFormat}
                    selectedQualityPreset={imageExportQualityPreset}
                    onQualityPresetChange={setImageExportQualityPreset}
                    canConvert={hasSelectedPages}
                    onConvert={handleExportSelectionAsImages}
                />
            ) : null}

            {isFinishDialogOpen ? (
                <FinishDialog
                    dialogRef={finishDialogRef}
                    onClose={closeFinishDialog}
                    options={printOverlayOptions}
                    onOptionsChange={setPrintOverlayOptions}
                />
            ) : null}
            {isProtectDialogOpen ? (
                <ProtectDialog
                    dialogRef={protectDialogRef}
                    onClose={closeProtectDialog}
                    password={protectPassword}
                    confirmation={protectPasswordConfirm}
                    onPasswordChange={setProtectPassword}
                    onConfirmationChange={setProtectPasswordConfirm}
                    onSubmit={handleProtectExport}
                    busy={isProcessing}
                />
            ) : null}

            {isUnlockDialogOpen ? (
                <UnlockDialog
                    dialogRef={unlockDialogRef}
                    onClose={closeUnlockDialog}
                    fileName={unlockFile?.name}
                    password={unlockPassword}
                    onPasswordChange={setUnlockPassword}
                    onSubmit={handleUnlockImport}
                    busy={isProcessing}
                />
            ) : null}

            {isClearAllDialogOpen ? (
                <ClearAllDialog
                    dialogRef={clearAllDialogRef}
                    onClose={closeClearAllDialog}
                    onConfirm={() => {
                        closeClearAllDialog();
                        clearSelection();
                        clearAll();
                    }}
                    busy={isProcessing}
                />
            ) : null}
        </div>
    );
};


