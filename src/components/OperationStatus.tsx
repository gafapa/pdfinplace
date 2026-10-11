import type { OperationProgress } from '../utils/editorOperation';
import { useI18n } from '../i18n';

export const OperationStatus = ({ operation, onCancel }: { operation: OperationProgress; onCancel: () => void }) => {
    const { t } = useI18n();
    return (
        <div className="fixed inset-x-4 top-20 z-[90] mx-auto flex max-w-md flex-wrap items-center gap-3 rounded-xl bg-white p-4 text-sm text-gray-700 shadow-xl" data-operation-status>
            <div className="min-w-0 flex-1" role="status" aria-live="polite">
                <p className="font-semibold">{t(operation.cancelling ? 'operation.cancelling' : `operation.${operation.kind}`)}</p>
                {operation.total > 0 ? <p className="mt-1 tabular-nums">{t('operation.progress', { completed: operation.completed, total: operation.total })}</p> : null}
            </div>
            <button type="button" className="rounded-lg border border-gray-300 px-3 py-2 font-semibold hover:bg-gray-100 disabled:opacity-50" disabled={operation.cancelling} onClick={onCancel}>{t('common.cancel')}</button>
            {operation.total > 0 ? <progress className="h-2 w-full accent-red-600" aria-label={t(`operation.${operation.kind}`)} max={operation.total} value={operation.completed} /> : null}
        </div>
    );
};
