import { useCallback, useEffect, useRef, useState } from 'react';
import { FilePenLine, Images, LayoutGrid, Lock, ShieldCheck } from 'lucide-react';
import { useI18n } from '../i18n';
import { useDialogFocus } from '../hooks/useDialogFocus';
import {
    getSessionPersistencePreference,
    setSessionPersistencePreference,
} from '../utils/sessionPreference';
import { setWelcomeDismissed } from '../utils/welcomePreference';

interface WelcomeModalProps {
    onClose: () => void;
}

export const WelcomeModal = ({ onClose }: WelcomeModalProps) => {
    const { t, locale } = useI18n();
    const [dontShowAgain, setDontShowAgain] = useState(false);
    const [saveSession, setSaveSession] = useState(getSessionPersistencePreference);
    const dontShowAgainRef = useRef(false);

    useEffect(() => {
        document.documentElement.dataset.welcomeOpen = 'true';
        return () => {
            delete document.documentElement.dataset.welcomeOpen;
        };
    }, []);

    const handleClose = useCallback(() => {
        if (dontShowAgainRef.current) {
            setWelcomeDismissed();
        }
        onClose();
    }, [onClose]);
    const dialogRef = useDialogFocus<HTMLDivElement>(true, handleClose);

    const handleDontShowAgainChange = (checked: boolean) => {
        dontShowAgainRef.current = checked;
        setDontShowAgain(checked);
    };

    const handleSaveSessionChange = (checked: boolean) => {
        setSaveSession(checked);
        setSessionPersistencePreference(checked);
    };

    const features = [
        { icon: Images, label: t('welcome.featureImageExport'), featured: true },
        { icon: FilePenLine, label: t('welcome.featureEdit') },
        { icon: LayoutGrid, label: t('welcome.featureOrganize') },
        { icon: Lock, label: t('welcome.featureProtect') },
        { icon: ShieldCheck, label: t('welcome.featurePrivate') },
    ];

    return (
        <div className="dialog-backdrop fixed inset-0 z-[300] flex items-center justify-center p-4 sm:p-6">
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="welcome-title"
                aria-describedby="welcome-description"
                tabIndex={-1}
                className="welcome-surface custom-scrollbar max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto p-6 sm:p-8"
            >
                <div className="mb-1 flex items-center gap-3 pt-1">
                    <div className="brand-mark h-11 w-11 rounded-xl">
                        <FilePenLine aria-hidden="true" className="h-6 w-6" />
                    </div>
                    <h1 id="welcome-title" className="text-xl font-bold tracking-tight text-gray-900 sm:text-2xl">
                        {t('welcome.title')}
                    </h1>
                </div>
                <p id="welcome-description" className="mt-4 max-w-[46ch] text-sm leading-6 text-gray-600">
                    {t('welcome.description')}
                </p>

                <ul className="mt-6 grid gap-2.5 sm:grid-cols-2">
                    {features.map((feature) => (
                        <li
                            key={feature.label}
                            className={`flex items-start gap-3 rounded-xl px-3.5 py-3 ${
                                feature.featured
                                    ? 'bg-red-50 text-red-900 sm:col-span-2'
                                    : 'bg-gray-50'
                            }`}
                        >
                            <feature.icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
                            <span className={`text-sm font-medium ${feature.featured ? 'text-red-900' : 'text-gray-700'}`}>
                                {feature.label}
                            </span>
                        </li>
                    ))}
                </ul>

                <div className="mt-6 border-t border-gray-200 pt-5">
                    <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-gray-50 p-3.5">
                        <input
                            type="checkbox"
                            checked={saveSession}
                            onChange={(event) => handleSaveSessionChange(event.target.checked)}
                            className="mt-0.5 h-5 w-5 shrink-0 rounded border-gray-300"
                        />
                        <span>
                            <span className="block text-sm font-semibold text-gray-800">
                                {t('welcome.saveSession')}
                            </span>
                            <span className="mt-1 block text-xs leading-5 text-gray-600">
                                {t('welcome.saveSessionDescription')}
                            </span>
                        </span>
                    </label>
                </div>

                <label className="mt-4 flex cursor-pointer items-center gap-2.5 rounded-lg py-1 text-sm text-gray-600">
                    <input
                        type="checkbox"
                        checked={dontShowAgain}
                        onChange={(event) => handleDontShowAgainChange(event.target.checked)}
                        className="h-4 w-4 rounded border-gray-300"
                    />
                    {t('welcome.dontShowAgain')}
                </label>

                <div className="mt-5 flex justify-end">
                    <button
                        type="button"
                        data-autofocus
                        onClick={handleClose}
                        className="primary-action h-11 w-full px-6 text-sm sm:w-auto"
                        title={t('welcome.start')}
                    >
                        {t('welcome.start')}
                    </button>
                </div>

                <nav aria-label={t('common.legal')} className="mt-6 flex flex-wrap gap-x-4 gap-y-1 border-t border-gray-100 pt-4 text-xs text-gray-500">
                    <a href={`./aviso-legal.html?lang=${locale}`} className="underline-offset-4 hover:text-red-600 hover:underline">Aviso legal</a>
                    <a href={`./privacidad.html?lang=${locale}`} className="underline-offset-4 hover:text-red-600 hover:underline">Privacidad</a>
                    <a href={`./terminos.html?lang=${locale}`} className="underline-offset-4 hover:text-red-600 hover:underline">Términos de uso</a>
                </nav>
            </div>
        </div>
    );
};
