import { readBrowserPreference } from '../utils/browserPreferences';
import { AVAILABLE_LOCALES, type Locale } from './locales';
import type { TranslationTree } from './translationTree';
import es from './locales/es';

export const LOCALE_STORAGE_KEY = 'pageforge.locale';

// Spanish ships in the main bundle as the fallback; other locales load on demand.
const loaders: Record<Exclude<Locale, 'es'>, () => Promise<{ default: TranslationTree }>> = {
    en: () => import('./locales/en'),
    gl: () => import('./locales/gl'),
    fr: () => import('./locales/fr'),
    de: () => import('./locales/de'),
    pt: () => import('./locales/pt'),
    ca: () => import('./locales/ca'),
    eu: () => import('./locales/eu'),
};
const loadedLocales = new Map<Locale, TranslationTree>([['es', es]]);

export const getLoadedLocale = (locale: Locale) => loadedLocales.get(locale);

/** Loads a locale's messages; resolves immediately once loaded. */
export const loadLocale = async (locale: Locale): Promise<TranslationTree> => {
    const cached = loadedLocales.get(locale);
    if (cached) return cached;
    const messages = (await loaders[locale as Exclude<Locale, 'es'>]()).default;
    loadedLocales.set(locale, messages);
    return messages;
};

const isLocale = (value: string): value is Locale => AVAILABLE_LOCALES.includes(value as Locale);

export const detectLocale = (): Locale => {
    if (typeof window === 'undefined') {
        return 'es';
    }

    const stored = readBrowserPreference(LOCALE_STORAGE_KEY);
    if (stored && isLocale(stored)) {
        return stored;
    }

    const browserLang = window.navigator.language.toLowerCase();
    const exactMatch = AVAILABLE_LOCALES.find((locale) => browserLang.startsWith(locale));
    return exactMatch ?? 'es';
};
