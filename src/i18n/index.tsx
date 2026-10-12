import { writeBrowserPreference } from '../utils/browserPreferences';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Locale } from './locales';
import type { TranslationTree } from './translationTree';
import es from './locales/es';
import { detectLocale, getLoadedLocale, LOCALE_STORAGE_KEY, loadLocale } from './loader';

const getByPath = (source: TranslationTree, path: string): string | undefined => {
    const keys = path.split('.');
    let current: string | TranslationTree | undefined = source;

    for (const key of keys) {
        if (!current || typeof current === 'string' || !(key in current)) {
            return undefined;
        }
        current = current[key];
    }

    return typeof current === 'string' ? current : undefined;
};

const interpolate = (template: string, params?: Record<string, string | number>): string => {
    if (!params) {
        return template;
    }

    return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
        const value = params[key];
        return value === undefined ? '' : String(value);
    });
};

interface I18nContextValue {
    locale: Locale;
    setLocale: (locale: Locale) => void;
    t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export const I18nProvider = ({ children }: { children: ReactNode }) => {
    const [requestedLocale] = useState<Locale>(detectLocale);
    const [locale, setLocaleState] = useState<Locale>(() => getLoadedLocale(requestedLocale) ? requestedLocale : 'es');

    const setLocale = useCallback((next: Locale) => {
        loadLocale(next).then(() => setLocaleState(next)).catch((error) => {
            console.error(`Could not load the ${next} translations:`, error);
        });
    }, []);

    useEffect(() => {
        // main.tsx preloads the detected locale; this covers a failed or skipped preload.
        if (requestedLocale !== 'es' && !getLoadedLocale(requestedLocale)) setLocale(requestedLocale);
    }, [requestedLocale, setLocale]);

    useEffect(() => {
        if (typeof window !== 'undefined') {
            writeBrowserPreference(LOCALE_STORAGE_KEY, locale);
        }
    }, [locale]);

    const t = useCallback((key: string, params?: Record<string, string | number>) => {
        const template = getByPath(getLoadedLocale(locale) ?? es, key) ?? getByPath(es, key) ?? key;
        return interpolate(template, params);
    }, [locale]);

    const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

    return (
        <I18nContext.Provider value={value}>
            {children}
        </I18nContext.Provider>
    );
};

// biome-ignore lint/style/useComponentExportOnlyModules: The locale hook intentionally shares this provider module.
export const useI18n = () => {
    const context = useContext(I18nContext);
    if (!context) {
        throw new Error('useI18n must be used within I18nProvider');
    }
    return context;
};

