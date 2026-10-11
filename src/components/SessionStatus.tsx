import { useI18n } from '../i18n';
import type { SessionSaveStatus } from '../hooks/useSessionPersistence';

interface SessionStatusProps {
    status: SessionSaveStatus;
    onRetry: () => void;
}

export const SessionStatus = ({ status, onRetry }: SessionStatusProps) => {
    const { t } = useI18n();
    const failed = status === 'error' || status === 'conflict';
    return (
        <div className={`flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm ${failed ? 'bg-red-50 text-red-800' : 'bg-gray-50 text-gray-600'}`}>
            <p role={failed ? 'alert' : 'status'} aria-live={failed ? 'assertive' : 'polite'} data-session-status={status}>
                {t(`session.${status}`)}
            </p>
            {status === 'error' ? (
                <button type="button" className="rounded-lg border border-red-300 px-3 py-1.5 font-semibold hover:bg-red-100" onClick={onRetry}>{t('session.retry')}</button>
            ) : null}
        </div>
    );
};
