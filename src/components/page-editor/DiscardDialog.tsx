import { useI18n } from '../../i18n';

const buttonClass = 'inline-flex h-9 items-center justify-center rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-700 hover:bg-gray-50';

interface DiscardDialogProps {
    onCancel: () => void;
    onDiscard: () => void;
}

/** Confirms closing the page editor with unsaved changes. */
export const DiscardDialog = ({ onCancel, onDiscard }: DiscardDialogProps) => {
    const { t } = useI18n();
    return (
        <div className="dialog-backdrop fixed inset-0 z-[200] flex items-center justify-center p-4">
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="discard-dialog-title"
                aria-describedby="discard-dialog-description"
                className="dialog-surface w-full max-w-sm p-5"
            >
                <h2 id="discard-dialog-title" className="mb-1 text-sm font-semibold text-gray-900">{t('modal.discardTitle')}</h2>
                <p id="discard-dialog-description" className="mb-3 text-xs text-gray-600">{t('modal.discardDescription')}</p>
                <div className="mt-4 flex justify-end gap-2">
                    <button
                        type="button"
                        autoFocus
                        onClick={onCancel}
                        className={buttonClass}
                        title={t('common.cancel')}
                        aria-label={t('common.cancel')}
                    >
                        {t('common.cancel')}
                    </button>
                    <button
                        type="button"
                        onClick={onDiscard}
                        className={`${buttonClass} border-red-300 text-red-600 hover:bg-red-50`}
                        title={t('modal.discard')}
                        aria-label={t('modal.discard')}
                    >
                        {t('modal.discard')}
                    </button>
                </div>
            </div>
        </div>
    );
};
