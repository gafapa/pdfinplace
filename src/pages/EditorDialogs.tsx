import { useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { Check, Columns2, Download, Lock, LockOpen, SlidersHorizontal, SplitSquareVertical, X } from 'lucide-react';
import { useI18n } from '../i18n';
import type { ImageExportOptions, PageSize, PrintOverlayOptions } from '../hooks/usePdfEditor';
import type { ImageExportQualityPreset } from '../utils/imageExport';
import type { ImageCompressionLevel } from '../features/export/compressImages';

type DialogRef = RefObject<HTMLDivElement | null>;
const toolbarIconButtonClass = 'toolbar-button text-xs font-medium whitespace-nowrap motion-reduce:transition-none';

interface ExportDialogProps {
    dialogRef: DialogRef;
    onClose: () => void;
    pageSize: PageSize;
    onPageSizeChange: (pageSize: PageSize) => void;
    imageCompression: ImageCompressionLevel;
    onImageCompressionChange: (level: ImageCompressionLevel) => void;
    canExport: boolean;
    onExportAll: () => void;
    pageCount: number;
    selectedCount: number;
    onExportSelection: () => void;
    rangeStart: string;
    rangeEnd: string;
    onRangeStartChange: (value: string) => void;
    onRangeEndChange: (value: string) => void;
    onExportRange: () => void;
    onSplit: (mode: 'single' | 'odd-even') => void;
    onProtect: () => void;
    onOpenFinish: () => void;
}

type ExportScope = 'all' | 'selection' | 'range';
const PAGE_SIZES: PageSize[] = ['Original', 'A4', 'A3', 'Letter', 'Legal'];
const COMPRESSION_LEVELS: ImageCompressionLevel[] = ['none', 'balanced', 'strong'];

/** "Equilibrada (150 ppp)" reads better as a name over a detail line. */
const splitDetail = (label: string) => {
    const match = label.match(/^(.*?)\s*\((.+)\)$/);
    return match ? { name: match[1], detail: match[2] } : { name: label, detail: '' };
};

export const ExportDialog = ({
    dialogRef,
    onClose,
    pageSize,
    onPageSizeChange,
    imageCompression,
    onImageCompressionChange,
    canExport,
    onExportAll,
    pageCount,
    selectedCount,
    onExportSelection,
    rangeStart,
    rangeEnd,
    onRangeStartChange,
    onRangeEndChange,
    onExportRange,
    onSplit,
    onProtect,
    onOpenFinish,
}: ExportDialogProps) => {
    const { t } = useI18n();
    const [scope, setScope] = useState<ExportScope>('all');
    const pageSizeLabels: Record<PageSize, string> = {
        Original: t('editor.pageSizeOriginal'),
        A4: 'A4',
        A3: 'A3',
        Letter: t('editor.pageSizeLetter'),
        Legal: t('editor.pageSizeLegal'),
    };
    const compressionLabels: Record<ImageCompressionLevel, string> = {
        none: t('editor.compressionNone'),
        balanced: t('editor.compressionBalanced'),
        strong: t('editor.compressionStrong'),
    };
    const scopes: { id: ExportScope; label: string; disabled?: boolean }[] = [
        { id: 'all', label: `${t('editor.scopeAll')} · ${pageCount}` },
        { id: 'selection', label: `${t('editor.scopeSelection')} · ${selectedCount}`, disabled: selectedCount === 0 },
        { id: 'range', label: t('editor.scopeRange') },
    ];
    const primary = {
        all: { label: t('editor.exportAll'), run: onExportAll },
        selection: { label: t('editor.exportSelected'), run: onExportSelection },
        range: { label: t('editor.exportRange'), run: onExportRange },
    }[scope];
    const moreOptions = [
        { icon: SplitSquareVertical, label: t('editor.splitSingle'), run: () => onSplit('single'), needsPages: true },
        { icon: Columns2, label: t('editor.splitOddEven'), run: () => onSplit('odd-even'), needsPages: true },
        { icon: Lock, label: t('editor.protectPdf'), run: onProtect, needsPages: true },
        { icon: SlidersHorizontal, label: t('editor.overlaySettings'), run: onOpenFinish, needsPages: false },
    ];

    return (
        <div className="dialog-backdrop dialog-backdrop--sheet fixed inset-0 z-40 flex items-center justify-center p-3 sm:p-4">
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="export-dialog-title"
                aria-describedby="export-dialog-description"
                tabIndex={-1}
                className="dialog-surface dialog-surface--sheet flex max-h-[calc(100vh-1.5rem)] w-full max-w-[34rem] flex-col gap-5 overflow-y-auto p-5 custom-scrollbar sm:max-h-[calc(100vh-2rem)] sm:p-6"
            >
                <div className="sheet-grabber" aria-hidden="true" />
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <h2 id="export-dialog-title" className="text-xl font-bold leading-tight text-gray-900">
                            {t('common.export')}
                        </h2>
                        <p id="export-dialog-description" className="mt-1 max-w-md text-sm text-gray-600">
                            {t('editor.exportDialogHint')}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className={`${toolbarIconButtonClass} shrink-0`}
                        title={t('common.close')}
                        aria-label={t('common.close')}
                    >
                        <X aria-hidden="true" className="h-4 w-4" />
                    </button>
                </div>

                <div className="flex flex-col gap-2">
                    <span id="export-scope-label" className="field-label">{t('editor.pagesLabel')}</span>
                    <div role="radiogroup" aria-labelledby="export-scope-label" className="segmented">
                        {scopes.map((option, index) => (
                            <label key={option.id} className="segmented-option">
                                <input
                                    type="radio"
                                    name="export-scope"
                                    value={option.id}
                                    checked={scope === option.id}
                                    disabled={option.disabled}
                                    onChange={() => setScope(option.id)}
                                    data-autofocus={index === 0 ? true : undefined}
                                />
                                <span>{option.label}</span>
                            </label>
                        ))}
                    </div>
                    {scope === 'range' ? (
                        <div className="grid grid-cols-2 gap-3 pt-1">
                            <label className="flex flex-col gap-1">
                                <span className="text-xs font-medium text-gray-600">{t('editor.rangeStart')}</span>
                                <input
                                    type="number"
                                    min={1}
                                    max={pageCount}
                                    value={rangeStart}
                                    onChange={(event) => onRangeStartChange(event.target.value)}
                                    className="h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700 tabular-nums"
                                />
                            </label>
                            <label className="flex flex-col gap-1">
                                <span className="text-xs font-medium text-gray-600">{t('editor.rangeEnd')}</span>
                                <input
                                    type="number"
                                    min={1}
                                    max={pageCount}
                                    value={rangeEnd}
                                    onChange={(event) => onRangeEndChange(event.target.value)}
                                    className="h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700 tabular-nums"
                                />
                            </label>
                        </div>
                    ) : null}
                </div>

                <div className="flex flex-col gap-2">
                    <span id="export-page-size-label" className="field-label">{t('editor.pageSize')}</span>
                    <div role="radiogroup" aria-labelledby="export-page-size-label" className="segmented">
                        {PAGE_SIZES.map(size => (
                            <label key={size} className="segmented-option">
                                <input
                                    type="radio"
                                    name="export-page-size"
                                    value={size}
                                    checked={pageSize === size}
                                    onChange={() => onPageSizeChange(size)}
                                />
                                <span>{pageSizeLabels[size]}</span>
                            </label>
                        ))}
                    </div>
                </div>

                <div className="flex flex-col gap-2">
                    <span id="export-image-compression-label" className="field-label">{t('editor.imageCompression')}</span>
                    <div
                        role="radiogroup"
                        aria-labelledby="export-image-compression-label"
                        aria-describedby="export-image-compression-hint"
                        className="option-cards"
                    >
                        {COMPRESSION_LEVELS.map(level => {
                            const { name, detail } = splitDetail(compressionLabels[level]);
                            return (
                                <label key={level} className="option-card">
                                    <input
                                        type="radio"
                                        name="export-image-compression"
                                        value={level}
                                        checked={imageCompression === level}
                                        onChange={() => onImageCompressionChange(level)}
                                    />
                                    <span className="option-card-body">
                                        <span className="option-card-text">
                                            <span>{name}</span>
                                            {detail ? <span className="option-card-detail">{detail}</span> : null}
                                        </span>
                                    </span>
                                </label>
                            );
                        })}
                    </div>
                    <p id="export-image-compression-hint" className="text-xs text-gray-600">
                        {t('editor.compressionHint')}
                    </p>
                </div>

                <button
                    type="button"
                    onClick={primary.run}
                    disabled={!canExport || (scope === 'selection' && selectedCount === 0)}
                    className="primary-action primary-action--large w-full"
                >
                    <Download aria-hidden="true" className="h-4 w-4" />
                    {primary.label}
                </button>

                <div className="flex flex-col gap-2 border-t border-gray-100 pt-4">
                    <span className="field-label">{t('editor.moreOptions')}</span>
                    <div className="more-options">
                        {moreOptions.map(option => (
                            <button
                                key={option.label}
                                type="button"
                                onClick={option.run}
                                disabled={option.needsPages && !canExport}
                                className="more-option"
                            >
                                <span className="more-option-icon"><option.icon aria-hidden="true" className="h-4 w-4" /></span>
                                {option.label}
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};

interface ImageExportDialogProps {
    dialogRef: DialogRef;
    onClose: () => void;
    selectedCount: number;
    selectedFormat: ImageExportOptions['format'];
    onFormatChange: (format: ImageExportOptions['format']) => void;
    selectedQualityPreset: ImageExportQualityPreset;
    onQualityPresetChange: (preset: ImageExportQualityPreset) => void;
    canConvert: boolean;
    onConvert: () => void;
}

export const ImageExportDialog = ({ dialogRef, onClose, selectedCount, selectedFormat, onFormatChange, selectedQualityPreset, onQualityPresetChange, canConvert, onConvert }: ImageExportDialogProps) => {
    const { t } = useI18n();
    return (
        <div className="dialog-backdrop fixed inset-0 z-40 flex items-center justify-center p-3 sm:p-4">
            <div
                ref={dialogRef}
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
                            {t('editor.imageExportHint', { count: selectedCount })}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
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
                                    onClick={() => onFormatChange(format.value)}
                                    aria-pressed={selectedFormat === format.value}
                                    className={`min-h-11 rounded-lg border px-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 ${
                                        selectedFormat === format.value
                                            ? 'border-blue-600 bg-blue-50 text-blue-800'
                                            : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:bg-gray-50'
                                    }`}
                                >
                                    {format.label}
                                </button>
                            ))}
                        </div>
                    </fieldset>

                    <fieldset>
                        <legend className="text-xs font-semibold text-gray-700">
                            {t('editor.imageQuality')}
                        </legend>
                        <div className="mt-2 grid grid-cols-3 gap-2">
                            {([
                                { value: 'compact', label: t('editor.imageQualityCompact') },
                                { value: 'balanced', label: t('editor.imageQualityBalanced') },
                                { value: 'maximum', label: t('editor.imageQualityMaximum') },
                            ] as const).map((qualityPreset) => (
                                <button
                                    key={qualityPreset.value}
                                    type="button"
                                    onClick={() => onQualityPresetChange(qualityPreset.value)}
                                    aria-pressed={selectedQualityPreset === qualityPreset.value}
                                    className={`min-h-11 rounded-lg border px-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 ${
                                        selectedQualityPreset === qualityPreset.value
                                            ? 'border-blue-600 bg-blue-50 text-blue-800'
                                            : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:bg-gray-50'
                                    }`}
                                >
                                    {qualityPreset.label}
                                </button>
                            ))}
                        </div>
                        <p className="mt-2 text-xs leading-5 text-gray-500">
                            {t(selectedFormat === 'png'
                                ? 'editor.imageQualityPngHint'
                                : 'editor.imageQualityLossyHint')}
                        </p>
                    </fieldset>

                    <button
                        type="button"
                        onClick={onConvert}
                        disabled={!canConvert}
                        className="primary-action min-h-11 w-full"
                        title={t('editor.convertAndDownloadImages')}
                    >
                        <Download aria-hidden="true" className="h-4 w-4" />
                        {t('editor.convertAndDownloadImages')}
                    </button>
                </div>
            </div>
        </div>
    );
};

interface FinishDialogProps {
    dialogRef: DialogRef;
    onClose: () => void;
    options: PrintOverlayOptions;
    onOptionsChange: Dispatch<SetStateAction<PrintOverlayOptions>>;
}

export const FinishDialog = ({ dialogRef, onClose, options, onOptionsChange }: FinishDialogProps) => {
    const { t } = useI18n();
    return (
        <div className="dialog-backdrop fixed inset-0 z-40 flex items-center justify-center p-3 sm:p-4">
            <div
                ref={dialogRef}
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
                        onClick={onClose}
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
                            value={options.watermarkText}
                            onChange={(event) => onOptionsChange(prev => ({ ...prev, watermarkText: event.target.value }))}
                            placeholder={t('editor.watermarkPlaceholder')}
                            className="h-11 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700"
                        />
                    </label>
                    <label className="block space-y-1">
                        <span className="text-xs font-medium text-gray-600">{t('editor.header')}</span>
                        <input
                            type="text"
                            value={options.headerText}
                            onChange={(event) => onOptionsChange(prev => ({ ...prev, headerText: event.target.value }))}
                            placeholder={t('editor.headerPlaceholder')}
                            className="h-11 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700"
                        />
                    </label>
                    <label className="block space-y-1">
                        <span className="text-xs font-medium text-gray-600">{t('editor.footer')}</span>
                        <input
                            type="text"
                            value={options.footerText}
                            onChange={(event) => onOptionsChange(prev => ({ ...prev, footerText: event.target.value }))}
                            placeholder={t('editor.footerPlaceholder')}
                            className="h-11 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700"
                        />
                    </label>
                    <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700">
                        <input
                            type="checkbox"
                            checked={options.includePageNumbers}
                            onChange={(event) => onOptionsChange(prev => ({ ...prev, includePageNumbers: event.target.checked }))}
                            className="h-4 w-4 rounded border-gray-300"
                        />
                        {t('editor.pageNumbers')}
                    </label>
                    <label className="block space-y-2 border-t border-gray-200 pt-4">
                        <span className="flex items-center justify-between gap-3">
                            <span className="text-xs font-medium text-gray-600">{t('editor.crop')}</span>
                            <span className="text-xs font-semibold tabular-nums text-gray-700">{options.cropPercent}%</span>
                        </span>
                        <input
                            type="range"
                            min={0}
                            max={20}
                            step={1}
                            value={options.cropPercent}
                            onChange={(event) => onOptionsChange(prev => ({ ...prev, cropPercent: Number(event.target.value) }))}
                            className="w-full"
                            aria-label={t('editor.crop')}
                        />
                    </label>
                    <label className="block space-y-2">
                        <span className="flex items-center justify-between gap-3">
                            <span className="text-xs font-medium text-gray-600">{t('editor.margin')}</span>
                            <span className="text-xs font-semibold tabular-nums text-gray-700">{options.marginPercent}%</span>
                        </span>
                        <input
                            type="range"
                            min={0}
                            max={20}
                            step={1}
                            value={options.marginPercent}
                            onChange={(event) => onOptionsChange(prev => ({ ...prev, marginPercent: Number(event.target.value) }))}
                            className="w-full"
                            aria-label={t('editor.margin')}
                        />
                    </label>
                </div>

                <div className="mt-5 border-t border-gray-200 pt-5">
                    <button
                        type="button"
                        onClick={onClose}
                        className="primary-action min-h-11 w-full"
                        title={t('common.close')}
                    >
                        <Check aria-hidden="true" className="h-4 w-4" />
                        {t('common.close')}
                    </button>
                </div>
            </div>
        </div>
    );
};

interface ProtectDialogProps {
    dialogRef: DialogRef;
    onClose: () => void;
    password: string;
    confirmation: string;
    onPasswordChange: (value: string) => void;
    onConfirmationChange: (value: string) => void;
    onSubmit: () => void;
    busy: boolean;
}

export const ProtectDialog = ({ dialogRef, onClose, password, confirmation, onPasswordChange, onConfirmationChange, onSubmit, busy }: ProtectDialogProps) => {
    const { t } = useI18n();
    return (
        <div className="dialog-backdrop fixed inset-0 z-40 flex items-center justify-center p-4">
            <div
                ref={dialogRef}
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
                        value={password}
                        onChange={(e) => onPasswordChange(e.target.value)}
                        className="h-9 w-full rounded-md border border-gray-300 px-2.5 text-sm text-gray-800 focus:border-gray-400 focus:outline-none"
                        placeholder={t('editor.password')}
                        aria-label={t('editor.password')}
                    />
                    <input
                        id="protect-password-confirm"
                        type="password"
                        autoComplete="new-password"
                        value={confirmation}
                        onChange={(e) => onConfirmationChange(e.target.value)}
                        className="h-9 w-full rounded-md border border-gray-300 px-2.5 text-sm text-gray-800 focus:border-gray-400 focus:outline-none"
                        placeholder={t('editor.confirmPassword')}
                        aria-label={t('editor.confirmPassword')}
                    />
                </div>
                <div className="mt-4 flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        className={toolbarIconButtonClass}
                        title={t('common.cancel')}
                        aria-label={t('common.cancel')}
                    >
                        <X className="h-4 w-4" />
                    </button>
                    <button
                        type="button"
                        onClick={onSubmit}
                        disabled={busy || !password.trim() || !confirmation.trim()}
                        className="primary-action"
                    >
                        <Lock aria-hidden="true" className="h-4 w-4" />
                        {t('editor.protectAndDownload')}
                    </button>
                </div>
            </div>
        </div>
    );
};

interface UnlockDialogProps {
    dialogRef: DialogRef;
    onClose: () => void;
    fileName?: string;
    password: string;
    onPasswordChange: (value: string) => void;
    onSubmit: () => void;
    busy: boolean;
}

export const UnlockDialog = ({ dialogRef, onClose, fileName, password, onPasswordChange, onSubmit, busy }: UnlockDialogProps) => {
    const { t } = useI18n();
    return (
        <div className="dialog-backdrop fixed inset-0 z-40 flex items-center justify-center p-4">
            <div
                ref={dialogRef}
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
                        {fileName ?? t('editor.noFileSelected')}
                    </span>
                </div>
                <input
                    id="unlock-password"
                    data-autofocus
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => onPasswordChange(e.target.value)}
                    className="h-9 w-full rounded-md border border-gray-300 px-2.5 text-sm text-gray-800 focus:border-gray-400 focus:outline-none"
                    placeholder={t('editor.password')}
                    aria-label={t('editor.password')}
                />
                <div className="mt-4 flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        className={toolbarIconButtonClass}
                        title={t('common.cancel')}
                        aria-label={t('common.cancel')}
                    >
                        <X className="h-4 w-4" />
                    </button>
                    <button
                        type="button"
                        onClick={onSubmit}
                        disabled={busy || !fileName || !password}
                        className="primary-action"
                    >
                        <LockOpen aria-hidden="true" className="h-4 w-4" />
                        {t('editor.unlockPdf')}
                    </button>
                </div>
            </div>
        </div>
    );
};

interface ClearAllDialogProps {
    dialogRef: DialogRef;
    onClose: () => void;
    onConfirm: () => void;
    busy: boolean;
}

export const ClearAllDialog = ({ dialogRef, onClose, onConfirm, busy }: ClearAllDialogProps) => {
    const { t } = useI18n();
    return (
        <div className="dialog-backdrop fixed inset-0 z-40 flex items-center justify-center p-4">
            <div
                ref={dialogRef}
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
                        onClick={onClose}
                        className="inline-flex h-9 items-center justify-center rounded-md border border-gray-200 bg-white px-3 text-xs font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                        title={t('common.cancel')}
                        aria-label={t('common.cancel')}
                    >
                        {t('common.cancel')}
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        disabled={busy}
                        className="inline-flex h-9 items-center justify-center rounded-md border border-red-300 bg-red-600 px-3 text-xs font-medium text-white hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 disabled:opacity-40"
                        title={t('common.clear')}
                        aria-label={t('common.clear')}
                    >
                        {t('common.clear')}
                    </button>
                </div>
            </div>
        </div>
    );
};
