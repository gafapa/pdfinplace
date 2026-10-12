import { useEffect, useState } from 'react';
import { FilePenLine, Images, LayoutGrid, Lock, TextCursorInput } from 'lucide-react';
import { useI18n } from '../i18n';
import {
    getSessionPersistencePreference,
    setSessionPersistencePreference,
    subscribeToSessionPreference,
} from '../utils/sessionPreference';

/** What the app does, shown on the start screen and in the app information dialog. */
export const FeatureList = () => {
    const { t } = useI18n();
    const features = [
        { icon: FilePenLine, label: t('welcome.featureEdit') },
        { icon: LayoutGrid, label: t('welcome.featureOrganize') },
        { icon: TextCursorInput, label: t('welcome.featureForms') },
        { icon: Lock, label: t('welcome.featureProtect') },
        { icon: Images, label: t('welcome.featureImageExport') },
    ];
    return (
        <ul className="feature-list">
            {features.map(feature => (
                <li key={feature.label} className="feature-item">
                    <span className="feature-icon"><feature.icon aria-hidden="true" className="h-4 w-4" /></span>
                    <span>{feature.label}</span>
                </li>
            ))}
        </ul>
    );
};

/** Opt-in switch for keeping the session in this browser; stays in sync across instances. */
export const SessionToggle = ({ id }: { id: string }) => {
    const { t } = useI18n();
    const [enabled, setEnabled] = useState(getSessionPersistencePreference);
    useEffect(() => subscribeToSessionPreference(setEnabled), []);
    return (
        <label htmlFor={id} className="session-toggle">
            <input
                id={id}
                type="checkbox"
                role="switch"
                className="switch"
                checked={enabled}
                onChange={event => {
                    setEnabled(event.target.checked);
                    setSessionPersistencePreference(event.target.checked);
                }}
            />
            <span>
                <span className="session-toggle-title">{t('welcome.saveSession')}</span>
                <span className="session-toggle-description">{t('welcome.saveSessionDescription')}</span>
            </span>
        </label>
    );
};

export const LegalLinks = () => {
    const { t, locale } = useI18n();
    return (
        <nav aria-label={t('common.legal')} className="legal-links">
            <a href={`./aviso-legal.html?lang=${locale}`}>Aviso legal</a>
            <a href={`./privacidad.html?lang=${locale}`}>Privacidad</a>
            <a href={`./terminos.html?lang=${locale}`}>Términos de uso</a>
        </nav>
    );
};
