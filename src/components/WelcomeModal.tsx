import { useEffect, useState } from 'react';
import { FilePenLine, LayoutGrid, Lock, ShieldCheck } from 'lucide-react';
import { useI18n } from '../i18n';
import { setWelcomeDismissed } from '../utils/welcomePreference';

interface WelcomeModalProps {
    onClose: () => void;
}

export const WelcomeModal = ({ onClose }: WelcomeModalProps) => {
    const { t, locale } = useI18n();
    const [dontShowAgain, setDontShowAgain] = useState(false);

    useEffect(() => {
        document.documentElement.dataset.welcomeOpen = 'true';
        return () => {
            delete document.documentElement.dataset.welcomeOpen;
        };
    }, []);

    const handleClose = () => {
        if (dontShowAgain) {
            setWelcomeDismissed();
        }
        onClose();
    };

    const features = [
        { icon: FilePenLine, label: t('welcome.featureEdit') },
        { icon: LayoutGrid, label: t('welcome.featureOrganize') },
        { icon: Lock, label: t('welcome.featureProtect') },
        { icon: ShieldCheck, label: t('welcome.featurePrivate') },
    ];

    return (
        <div className="dialog-backdrop fixed inset-0 z-[300] flex items-center justify-center p-4 sm:p-6">
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="welcome-title"
                aria-describedby="welcome-description"
                className="welcome-surface w-full max-w-lg p-6 sm:p-8"
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
                        <li key={feature.label} className="flex items-start gap-3 rounded-xl bg-gray-50 px-3.5 py-3">
                            <feature.icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
                            <span className="text-sm font-medium text-gray-700">{feature.label}</span>
                        </li>
                    ))}
                </ul>

                <label className="mt-6 flex cursor-pointer items-center gap-2.5 rounded-lg py-1 text-sm text-gray-600">
                    <input
                        type="checkbox"
                        checked={dontShowAgain}
                        onChange={(event) => setDontShowAgain(event.target.checked)}
                        className="h-4 w-4 rounded border-gray-300"
                    />
                    {t('welcome.dontShowAgain')}
                </label>

                <div className="mt-5 flex justify-end">
                    <button
                        type="button"
                        autoFocus
                        onClick={handleClose}
                        className="primary-action h-11 w-full px-6 text-sm sm:w-auto"
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
