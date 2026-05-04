import { Suspense, lazy, useCallback, useRef, useState } from 'react';
import { usePdfEditor, type EditorFile, type EditorPage, type PageSize } from '../hooks/usePdfEditor';
import { PdfPreview } from '../components/PdfPreview';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragOverlay } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Upload, RotateCw, Trash2, Download, Plus, ZoomIn, ZoomOut, Undo, Redo, FileText, Lock, LockOpen, FolderOpen, Check, X } from 'lucide-react';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { useI18n, type Locale } from '../i18n';

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

const LanguageIcon = ({ locale }: { locale: Locale }) => {
    if (locale === 'es') {
        return (
            <svg viewBox="0 0 24 24" className="w-4 h-4 rounded-sm" aria-hidden="true">
                <rect width="24" height="24" fill="#C60B1E" />
                <rect y="6" width="24" height="12" fill="#FFC400" />
            </svg>
        );
    }

    if (locale === 'en') {
        return (
            <svg viewBox="0 0 24 24" className="w-4 h-4 rounded-sm" aria-hidden="true">
                <rect width="24" height="24" fill="#012169" />
                <polygon points="0,0 3,0 24,15 24,18 21,18 0,3" fill="#FFFFFF" />
                <polygon points="24,0 21,0 0,15 0,18 3,18 24,3" fill="#FFFFFF" />
                <polygon points="0,0 1.6,0 24,16 24,18 22.4,18 0,2" fill="#C8102E" />
                <polygon points="24,0 22.4,0 0,16 0,18 1.6,18 24,2" fill="#C8102E" />
                <rect x="10" width="4" height="24" fill="#FFFFFF" />
                <rect y="10" width="24" height="4" fill="#FFFFFF" />
                <rect x="11" width="2" height="24" fill="#C8102E" />
                <rect y="11" width="24" height="2" fill="#C8102E" />
            </svg>
        );
    }

    return (
        <svg viewBox="0 0 24 24" className="w-4 h-4 rounded-sm" aria-hidden="true">
            <rect width="24" height="24" fill="#FFFFFF" />
            <polygon points="0,2 6,0 24,22 18,24" fill="#0099DD" />
        </svg>
    );
};

interface SortablePageProps {
    id: string;
    page: EditorPage;
    file?: EditorFile;
    onRotate: (pageId: string) => void;
    onDelete: (pageId: string) => void;
    onSelect: (pageId: string) => void;
    scale: number;
    newPageIndex: number;
    documentColor: string;
    rotateLabel: string;
    deleteLabel: string;
}

// Sortable Item Component
const SortablePage = ({
    id,
    page,
    file,
    onRotate,
    onDelete,
    onSelect,
    scale,
    newPageIndex,
    documentColor,
    rotateLabel,
    deleteLabel
}: SortablePageProps) => {
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
                className="bg-white rounded shadow-sm hover:shadow-md transition-shadow overflow-hidden cursor-pointer"
                style={{ border: `3px solid ${documentColor}` }}
                {...attributes}
                {...listeners}
                onDoubleClick={(e) => { e.stopPropagation(); onSelect(id); }}
            >
                <div>
                    <PdfPreview
                        pdfDocument={file?.pdfDoc}
                        pageIndex={page.pageIndex}
                        width={180 * scale}
                        height={180 * scale}
                        rotation={page.rotation}
                        className="pointer-events-none"
                        annotations={page.annotations}
                    />
                </div>
            </div>

            {/* Overlay Actions */}
            <div className="absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                    onClick={(e) => { e.stopPropagation(); onRotate(id); }}
                    className="p-1 bg-white rounded shadow text-gray-700 hover:text-blue-600 hover:bg-blue-50"
                    title={rotateLabel}
                >
                    <RotateCw className="w-4 h-4" />
                </button>
                <button
                    onClick={(e) => { e.stopPropagation(); onDelete(id); }}
                    className="p-1 bg-white rounded shadow text-gray-700 hover:text-red-600 hover:bg-red-50"
                    title={deleteLabel}
                >
                    <Trash2 className="w-4 h-4" />
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
};

export const PdfEditor = () => {
    const { locale, setLocale, t } = useI18n();
    const {
        files,
        pages,
        isProcessing,
        pageSize,
        setPageSize,
        addFiles,
        movePage,
        rotatePage,
        deletePage,
        exportPdf,
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
    const [scale, setScale] = useState(1);
    const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
    const [isProtectDialogOpen, setIsProtectDialogOpen] = useState(false);
    const [isUnlockDialogOpen, setIsUnlockDialogOpen] = useState(false);
    const [protectPassword, setProtectPassword] = useState('');
    const [protectPasswordConfirm, setProtectPasswordConfirm] = useState('');
    const [unlockPassword, setUnlockPassword] = useState('');
    const [unlockFile, setUnlockFile] = useState<File | null>(null);
    const addFilesInputRef = useRef<HTMLInputElement>(null);
    const unlockFileInputRef = useRef<HTMLInputElement>(null);

    const toolbarButtonClass = "inline-flex h-8 w-8 items-center justify-center rounded-md border border-gray-200 bg-white hover:bg-gray-50 text-gray-700 text-xs font-medium transition-colors whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed";
    const toolbarIconButtonClass = toolbarButtonClass;
    const canExport = pages.length > 0 && !isProcessing;

    const handleFilesPicked = useCallback((filesList: FileList | null) => {
        if (!filesList) {
            return;
        }
        addFiles(Array.from(filesList));
    }, [addFiles]);

    const triggerAddFiles = useCallback(() => {
        addFilesInputRef.current?.click();
    }, []);

    const handleExport = useCallback(() => {
        if (!canExport) {
            return;
        }

        exportPdf({
            failed: t('editor.exportFailed'),
            downloadPrefix: t('editor.downloadPrefix'),
            originalName: t('editor.originalSizeName'),
        });
    }, [
        canExport,
        exportPdf,
        t
    ]);

    const closeProtectDialog = useCallback(() => {
        setIsProtectDialogOpen(false);
        setProtectPassword('');
        setProtectPasswordConfirm('');
    }, []);

    const closeUnlockDialog = useCallback(() => {
        setIsUnlockDialogOpen(false);
        setUnlockPassword('');
        setUnlockFile(null);
    }, []);

    const triggerUnlockFilePicker = useCallback(() => {
        unlockFileInputRef.current?.click();
    }, []);

    const handleProtectExport = useCallback(async () => {
        if (!canExport) {
            return;
        }

        if (protectPassword.trim() !== protectPasswordConfirm.trim()) {
            alert(t('editor.passwordMismatch'));
            return;
        }

        const success = await exportProtectedPdf(protectPassword, {
            failed: t('editor.protectFailed'),
            invalidPassword: t('editor.invalidPassword'),
            downloadPrefix: t('editor.protectedDownloadPrefix'),
            originalName: t('editor.originalSizeName'),
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

    const handleUnlockExport = useCallback(async () => {
        const success = await unlockPdfFile(unlockFile, unlockPassword, {
            failed: t('editor.unlockFailed'),
            invalidPassword: t('editor.invalidPassword'),
            invalidFile: t('editor.unlockInvalidFile'),
            downloadPrefix: t('editor.unlockedDownloadPrefix'),
        });

        if (success) {
            closeUnlockDialog();
        }
    }, [unlockPdfFile, unlockFile, unlockPassword, t, closeUnlockDialog]);

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
                addFiles(droppedFiles);
            }
        }
    };

    return (
        <div
            className="relative flex h-full flex-col overflow-hidden"
            onDragOver={handleDragOver}
            onDrop={handleDrop}
        >
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
            <input
                ref={unlockFileInputRef}
                type="file"
                accept=".pdf,application/pdf"
                className="hidden"
                onChange={(e) => {
                    const selected = e.target.files?.[0] ?? null;
                    setUnlockFile(selected);
                    e.target.value = '';
                }}
            />
            {/* Toolbar */}
            <div className="bg-white border-b border-gray-200 px-2 sm:px-3 py-2 shadow-sm z-10">
                <div className="flex items-center justify-between gap-2 pb-2 border-b border-gray-100">
                    <div className="flex items-center gap-2 shrink-0">
                        <div className="bg-red-600 p-1.5 rounded text-white">
                            <FileText className="w-5 h-5" />
                        </div>
                        <span className="text-base sm:text-lg font-bold tracking-tight text-gray-900">{t('app.title')}</span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0" title={t('common.language')}>
                        {(['es', 'gl', 'en'] as Locale[]).map((lang) => (
                            <button
                                key={lang}
                                type="button"
                                onClick={() => setLocale(lang)}
                                className={`${toolbarIconButtonClass} ${locale === lang ? 'ring-1 ring-gray-400' : ''}`}
                                title={t(`language.${lang}`)}
                                aria-label={t(`language.${lang}`)}
                            >
                                <LanguageIcon locale={lang} />
                            </button>
                        ))}
                    </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-[1fr_auto_1fr] items-center gap-2 pt-2">
                    <div className="col-span-2 sm:col-span-1 min-w-0 flex items-center gap-2 overflow-x-auto whitespace-nowrap">
                        <button
                            type="button"
                            onClick={triggerAddFiles}
                            className={`${toolbarIconButtonClass} shrink-0`}
                            title={t('common.add')}
                            aria-label={t('common.add')}
                        >
                            <Plus className="w-4 h-4" />
                        </button>
                        <button
                            onClick={clearAll}
                            className={toolbarIconButtonClass}
                            title={t('common.clear')}
                            aria-label={t('common.clear')}
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                        </button>
                    </div>
                    <div className="col-span-1 sm:col-span-1 flex items-center justify-start sm:justify-center gap-2">
                        <button
                            onClick={undo}
                            disabled={!canUndo}
                            className={toolbarIconButtonClass}
                            title={t('editor.undo')}
                        >
                            <Undo className="w-4 h-4" />
                        </button>
                        <button
                            onClick={redo}
                            disabled={!canRedo}
                            className={toolbarIconButtonClass}
                            title={t('editor.redo')}
                        >
                            <Redo className="w-4 h-4" />
                        </button>
                    </div>
                    <div className="col-span-1 sm:col-span-1 min-w-0 flex items-center justify-end gap-2 overflow-x-auto whitespace-nowrap">
                        <select
                            value={pageSize}
                            onChange={(e) => setPageSize(e.target.value as PageSize)}
                            className="h-8 rounded-md bg-white hover:bg-gray-50 border border-gray-200 text-gray-700 text-xs font-medium px-2.5 focus:ring-1 focus:ring-gray-300 focus:border-gray-300"
                        >
                            <option value="Original">{t('editor.pageSizeOriginal')}</option>
                            <option value="A4">A4</option>
                            <option value="A3">A3</option>
                            <option value="Letter">{t('editor.pageSizeLetter')}</option>
                            <option value="Legal">{t('editor.pageSizeLegal')}</option>
                        </select>
                        <button
                            onClick={handleExport}
                            disabled={!canExport}
                            className={toolbarIconButtonClass}
                            title={t('common.export')}
                            aria-label={t('common.export')}
                        >
                            <Download className="w-4 h-4" />
                        </button>
                        <button
                            type="button"
                            onClick={() => setIsProtectDialogOpen(true)}
                            disabled={!canExport}
                            className={toolbarIconButtonClass}
                            title={t('editor.protectPdf')}
                            aria-label={t('editor.protectPdf')}
                        >
                            <Lock className="w-4 h-4" />
                        </button>
                        <button
                            type="button"
                            onClick={() => setIsUnlockDialogOpen(true)}
                            className={toolbarIconButtonClass}
                            title={t('editor.unlockPdf')}
                            aria-label={t('editor.unlockPdf')}
                        >
                            <LockOpen className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            </div>

            {/* Main Content */}
            <div className="flex-1 bg-white overflow-y-auto p-3 sm:p-5 lg:p-8 custom-scrollbar">
                {pages.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-gray-400 border-2 border-dashed border-gray-300 rounded-xl m-1 sm:m-4 p-4">
                        <Upload className="w-12 h-12 sm:w-16 sm:h-16 mb-4 text-gray-300" />
                        <h3 className="text-base sm:text-xl font-medium text-gray-600 mb-2 text-center">{t('editor.dragDropTitle')}</h3>
                        <p className="max-w-md text-center mb-6 text-sm sm:text-base">{t('editor.dragDropDescription')}</p>
                        <label className="btn bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-2 cursor-pointer shadow-lg hover:-translate-y-1" title={t('editor.addFirst')} aria-label={t('editor.addFirst')}>
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
                                            onSelect={setSelectedPageId}
                                            scale={scale}
                                            newPageIndex={index + 1}
                                            documentColor={getDocumentColor(page.fileId, fileIds)}
                                            rotateLabel={t('editor.rotate')}
                                            deleteLabel={t('editor.deletePage')}
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
                                                        pdfDocument={files[page.fileId]?.pdfDoc}
                                                        pageIndex={page.pageIndex}
                                                        width={180 * scale}
                                                        height={180 * scale}
                                                        rotation={page.rotation}
                                                        annotations={page.annotations}
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

            <div className="pointer-events-none absolute right-2 sm:right-3 bottom-14 sm:bottom-auto sm:top-1/2 z-20 sm:-translate-y-1/2">
                <div className="pointer-events-auto flex flex-col gap-2 rounded-lg border border-gray-200 bg-white/95 p-1 shadow-sm backdrop-blur">
                    <button
                        onClick={() => setScale(s => Math.max(0.5, s - 0.1))}
                        className={toolbarIconButtonClass}
                        title={t('editor.zoomOut')}
                    >
                        <ZoomOut className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => setScale(s => Math.min(2, s + 0.1))}
                        className={toolbarIconButtonClass}
                        title={t('editor.zoomIn')}
                    >
                        <ZoomIn className="w-4 h-4" />
                    </button>
                </div>
            </div>
            <div className="pointer-events-none absolute bottom-2 sm:bottom-3 right-2 sm:right-3 z-20 rounded-md border border-gray-200 bg-white/95 px-2 py-1 text-xs font-medium text-gray-600 shadow-sm backdrop-blur">
                {t('common.pagesCount', { count: pages.length })}
            </div>

            {/* Page Editor Modal */}
            {(() => {
                const selectedPage = selectedPageId ? pages.find(p => p.id === selectedPageId) : null;
                if (!selectedPage) return null;
                return (
                    <Suspense
                        fallback={
                            <div className="fixed inset-0 z-40 flex items-center justify-center bg-white/80">
                                <div className="h-8 w-8 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
                            </div>
                        }
                    >
                        <LazyPageEditorModal
                            isOpen={!!selectedPageId}
                            onClose={() => setSelectedPageId(null)}
                            onSave={(annotations) => {
                                updatePageAnnotations(selectedPageId!, annotations);
                            }}
                            pdfDocument={files[selectedPage.fileId]?.pdfDoc}
                            pageIndex={selectedPage.pageIndex}
                            pageRotation={selectedPage.rotation}
                            initialAnnotations={selectedPage.annotations || []}
                        />
                    </Suspense>
                );
            })()}

            {isProtectDialogOpen ? (
                <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
                    <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-4 shadow-xl">
                        <h3 className="mb-1 text-sm font-semibold text-gray-900">{t('editor.protectPdf')}</h3>
                        <p className="mb-3 text-xs text-gray-600">{t('editor.protectHint')}</p>
                        <div className="space-y-2">
                            <input
                                type="password"
                                autoComplete="new-password"
                                value={protectPassword}
                                onChange={(e) => setProtectPassword(e.target.value)}
                                className="h-9 w-full rounded-md border border-gray-300 px-2.5 text-sm text-gray-800 focus:border-gray-400 focus:outline-none"
                                placeholder={t('editor.password')}
                            />
                            <input
                                type="password"
                                autoComplete="new-password"
                                value={protectPasswordConfirm}
                                onChange={(e) => setProtectPasswordConfirm(e.target.value)}
                                className="h-9 w-full rounded-md border border-gray-300 px-2.5 text-sm text-gray-800 focus:border-gray-400 focus:outline-none"
                                placeholder={t('editor.confirmPassword')}
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
                <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
                    <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-4 shadow-xl">
                        <h3 className="mb-1 text-sm font-semibold text-gray-900">{t('editor.unlockPdf')}</h3>
                        <p className="mb-3 text-xs text-gray-600">{t('editor.unlockHint')}</p>
                        <div className="mb-2 flex min-h-9 items-center gap-2 rounded-md border border-gray-300 px-2 py-1">
                            <button
                                type="button"
                                onClick={triggerUnlockFilePicker}
                                className={toolbarIconButtonClass}
                                title={t('editor.selectFile')}
                                aria-label={t('editor.selectFile')}
                            >
                                <FolderOpen className="h-4 w-4" />
                            </button>
                            <span className="truncate text-xs text-gray-700">
                                {unlockFile?.name ?? t('editor.noFileSelected')}
                            </span>
                        </div>
                        <input
                            type="password"
                            autoComplete="current-password"
                            value={unlockPassword}
                            onChange={(e) => setUnlockPassword(e.target.value)}
                            className="h-9 w-full rounded-md border border-gray-300 px-2.5 text-sm text-gray-800 focus:border-gray-400 focus:outline-none"
                            placeholder={t('editor.password')}
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
                                onClick={handleUnlockExport}
                                disabled={isProcessing || !unlockFile || !unlockPassword.trim()}
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
        </div>
    );
};


