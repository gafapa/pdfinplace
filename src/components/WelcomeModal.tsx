import { useEffect, useState } from 'react';
import { FilePenLine, LayoutGrid, Lock, ShieldCheck } from 'lucide-react';
import { useI18n } from '../i18n';
import { setWelcomeDismissed } from '../utils/welcomePreference';

interface WelcomeModalProps {
    onClose: () => void;
}

export const WelcomeModal = ({ onClose }: WelcomeModalProps) => {
    const { t } = useI18n();
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
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-white/85 p-4 backdrop-blur-sm">
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="welcome-title"
                aria-describedby="welcome-description"
                className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white p-6 shadow-2xl sm:p-8"
            >
                <div className="mb-1 flex items-center gap-3">
                    <div className="rounded-xl bg-blue-600 p-2.5 text-white shadow-sm">
                        <FilePenLine aria-hidden="true" className="h-6 w-6" />
                    </div>
                    <h1 id="welcome-title" className="text-xl font-bold tracking-tight text-gray-900 sm:text-2xl">
                        {t('welcome.title')}
                    </h1>
                </div>
                <p id="welcome-description" className="mt-3 text-sm leading-relaxed text-gray-600">
                    {t('welcome.description')}
                </p>

                <ul className="mt-5 space-y-2.5">
                    {features.map((feature) => (
                        <li key={feature.label} className="flex items-start gap-3 rounded-xl border border-gray-100 bg-gray-50/80 px-3 py-2.5">
                            <feature.icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
                            <span className="text-sm font-medium text-gray-700">{feature.label}</span>
                        </li>
                    ))}
                </ul>

                <label className="mt-5 flex cursor-pointer items-center gap-2.5 text-sm text-gray-600">
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
                        className="inline-flex h-11 items-center justify-center rounded-xl bg-blue-600 px-6 text-sm font-semibold text-white shadow-md transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
                    >
                        {t('welcome.start')}
                    </button>
                </div>

                <nav aria-label={t('common.legal')} className="mt-5 flex flex-wrap gap-x-4 gap-y-1 border-t border-gray-100 pt-4 text-xs text-gray-500">
                    <a href="./aviso-legal.html" className="hover:text-blue-600 hover:underline">Aviso legal</a>
                    <a href="./privacidad.html" className="hover:text-blue-600 hover:underline">Privacidad</a>
                    <a href="./terminos.html" className="hover:text-blue-600 hover:underline">Términos de uso</a>
                </nav>
            </div>
        </div>
    );
};
