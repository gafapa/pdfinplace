import { useI18n } from '../i18n';
import type { SessionSaveStatus } from '../hooks/useSessionPersistence';

/** Quiet save state shown next to the brand; opens the session settings. */
export const SessionPill = ({ status, onOpenSettings }: { status: SessionSaveStatus; onOpenSettings: () => void }) => {
    const { t } = useI18n();
    const tone = status === 'saved' ? 'saved' : status === 'saving' || status === 'pending' ? 'busy' : 'idle';
    return (
        <button type="button" className="session-pill" data-tone={tone} onClick={onOpenSettings} title={t(`session.${status}`)}>
            <span className="session-pill-dot" aria-hidden="true" />
            <span className="session-pill-text" role="status" aria-live="polite" data-session-status={status}>
                {t(`session.${status}`)}
            </span>
        </button>
    );
};

/** Save failures need attention, so they get a full-width alert below the header. */
export const SessionAlert = ({ status, onRetry }: { status: SessionSaveStatus; onRetry: () => void }) => {
    const { t } = useI18n();
    return (
        <div className="flex flex-wrap items-center justify-between gap-2 bg-red-50 px-4 py-2 text-sm text-red-800">
            <p role="alert" aria-live="assertive" data-session-status={status}>
                {t(`session.${status}`)}
            </p>
            {status === 'error' ? (
                <button type="button" className="rounded-lg border border-red-300 px-3 py-1.5 font-semibold hover:bg-red-100" onClick={onRetry}>{t('session.retry')}</button>
            ) : null}
        </div>
    );
};
