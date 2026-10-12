import { FileText, X } from 'lucide-react';
import { useI18n } from '../i18n';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { FeatureList, LegalLinks, SessionToggle } from './AppIntro';

/**
 * What the app does, the session switch and the legal pages, for when the
 * start screen is no longer visible. Opened from the brand or the session pill.
 */
export const AppInfoDialog = ({ onClose }: { onClose: () => void }) => {
    const { t } = useI18n();
    const dialogRef = useDialogFocus<HTMLDivElement>(true, onClose);
    return (
        <div className="dialog-backdrop dialog-backdrop--sheet fixed inset-0 z-[300] flex items-center justify-center p-4 sm:p-6">
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="app-info-title"
                aria-describedby="app-info-description"
                tabIndex={-1}
                className="info-surface dialog-surface--sheet custom-scrollbar max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto"
            >
                <div className="sheet-grabber" aria-hidden="true" />
                <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 items-center gap-3">
                        <div className="brand-mark">
                            <FileText aria-hidden="true" className="h-5 w-5" />
                        </div>
                        <h2 id="app-info-title" className="info-title">{t('welcome.title')}</h2>
                    </div>
                    <button
                        type="button"
                        data-autofocus
                        onClick={onClose}
                        className="toolbar-button shrink-0"
                        title={t('common.close')}
                        aria-label={t('common.close')}
                    >
                        <X aria-hidden="true" className="h-4 w-4" />
                    </button>
                </div>
                <p id="app-info-description" className="info-description mt-0">{t('welcome.description')}</p>
                <FeatureList />
                <SessionToggle id="info-save-session" />
                <LegalLinks />
            </div>
        </div>
    );
};
