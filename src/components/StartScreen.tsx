import { Plus, Upload } from 'lucide-react';
import { useI18n } from '../i18n';
import { FeatureList, LegalLinks, SessionToggle } from './AppIntro';

interface StartScreenProps {
    disabled: boolean;
    onAddFiles: () => void;
}

/** The empty workspace: the drop zone next to what the app does and the session switch. */
export const StartScreen = ({ disabled, onAddFiles }: StartScreenProps) => {
    const { t } = useI18n();
    return (
        <div className="start-screen">
            <div className="start-layout">
                <section className="start-drop" aria-labelledby="start-title">
                    <div className="start-drop-icon">
                        <Upload aria-hidden="true" className="h-7 w-7" />
                    </div>
                    <div>
                        {/* Phones and tablets cannot drag files in, so they get a tap-oriented title. */}
                        <h1 id="start-title" className="start-title">
                            <span className="[@media(hover:none)]:hidden">{t('editor.dragDropTitle')}</span>
                            <span className="hidden [@media(hover:none)]:inline">{t('editor.dragDropTitleTouch')}</span>
                        </h1>
                        <p className="start-hint">{t('editor.supportedFilesHint')}</p>
                    </div>
                    <button type="button" onClick={onAddFiles} disabled={disabled} className="primary-action start-cta">
                        <Plus aria-hidden="true" className="h-5 w-5" />
                        {t('editor.addFiles')}
                    </button>
                    <ul className="start-limits">
                        <li>{t('editor.limitFiles')}</li>
                        <li>{t('editor.limitSize')}</li>
                        <li>{t('editor.limitPages')}</li>
                    </ul>
                </section>
                <section className="start-welcome" aria-labelledby="start-welcome-title">
                    <div>
                        <h2 id="start-welcome-title" className="info-title">{t('welcome.title')}</h2>
                        <p className="info-description">{t('welcome.description')}</p>
                    </div>
                    <FeatureList />
                    <SessionToggle id="start-save-session" />
                    <LegalLinks />
                </section>
            </div>
        </div>
    );
};
