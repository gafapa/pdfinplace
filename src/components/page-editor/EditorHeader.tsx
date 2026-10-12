import { Check, ChevronLeft, ChevronRight, Redo, Undo, X } from 'lucide-react';
import { useI18n } from '../../i18n';

interface EditorHeaderProps {
    /** Position of the page in the document. */
    pagePosition: number;
    /** Pages in the document; omitted when the editor has no page navigation. */
    pageCount?: number;
    navigation?: { hasPrevious: boolean; hasNext: boolean; onNavigate: (delta: 1 | -1) => void };
    canSave: boolean;
    canUndo: boolean;
    canRedo: boolean;
    onUndo: () => void;
    onRedo: () => void;
    onCancel: () => void;
    onSave: () => void;
}

export const EditorHeader = ({ pagePosition, pageCount, navigation, canSave, canUndo, canRedo, onUndo, onRedo, onCancel, onSave }: EditorHeaderProps) => {
    const { t } = useI18n();
    const title = pageCount
        ? t('modal.pageOf', { page: pagePosition, total: pageCount })
        : `${t('common.page')} ${pagePosition}`;
    const titleElement = (
        <h2 id="page-editor-title" className="editor-title">
            <span className="editor-title-long">{title}</span>
            {/* Phones show the compact "1 / 7"; the full title stays for screen readers. */}
            <span className="editor-title-short" aria-hidden="true">
                {pageCount ? <>{pagePosition} <span className="editor-title-total">/ {pageCount}</span></> : title}
            </span>
        </h2>
    );
    return (
        <div className="workspace-header editor-header z-[60] text-gray-900">
            <div className="editor-header-group">
                <button
                    type="button"
                    onClick={onCancel}
                    className="toolbar-button toolbar-button--ghost mobile-only"
                    title={t('common.cancel')}
                    aria-label={t('common.cancel')}
                >
                    <X aria-hidden="true" className="h-5 w-5" />
                </button>
                {navigation ? (
                    <div role="group" aria-label={t('modal.pageNavigation')} className="editor-header-group">
                        <button
                            type="button"
                            onClick={() => navigation.onNavigate(-1)}
                            disabled={!navigation.hasPrevious || !canSave}
                            className="toolbar-button toolbar-button--ghost"
                            title={t('modal.previousPage')}
                            aria-label={t('modal.previousPage')}
                        >
                            <ChevronLeft aria-hidden="true" className="h-4 w-4" />
                        </button>
                        {titleElement}
                        <button
                            type="button"
                            onClick={() => navigation.onNavigate(1)}
                            disabled={!navigation.hasNext || !canSave}
                            className="toolbar-button toolbar-button--ghost"
                            title={t('modal.nextPage')}
                            aria-label={t('modal.nextPage')}
                        >
                            <ChevronRight aria-hidden="true" className="h-4 w-4" />
                        </button>
                    </div>
                ) : titleElement}
            </div>
            <div className="editor-header-actions">
                <button type="button" onClick={onUndo} disabled={!canUndo} className="toolbar-button toolbar-button--ghost" title={t('editor.undo')} aria-label={t('editor.undo')}>
                    <Undo aria-hidden="true" className="h-4 w-4" />
                </button>
                <button type="button" onClick={onRedo} disabled={!canRedo} className="toolbar-button toolbar-button--ghost desktop-only" title={t('editor.redo')} aria-label={t('editor.redo')}>
                    <Redo aria-hidden="true" className="h-4 w-4" />
                </button>
                <span className="header-divider desktop-only" aria-hidden="true" />
                <button type="button" onClick={onCancel} className="toolbar-button toolbar-button--labelled desktop-only">
                    {t('common.cancel')}
                </button>
                <button
                    type="button"
                    onClick={onSave}
                    disabled={!canSave}
                    className="primary-action"
                    title={t('common.save')}
                    aria-label={t('common.save')}
                >
                    <Check aria-hidden="true" className="h-4 w-4" />
                    <span>{t('common.save')}</span>
                </button>
            </div>
        </div>
    );
};
