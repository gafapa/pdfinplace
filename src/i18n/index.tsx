import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Locale = 'es' | 'en' | 'gl';

type TranslationNode = string | { [key: string]: TranslationNode };

const STORAGE_KEY = 'pdfing.locale';

const translations: Record<Locale, TranslationNode> = {
    es: {
        app: {
            title: 'PDFing',
            windowTitle: 'PDFing - Editor PDF',
        },
        common: {
            language: 'Idioma',
            cancel: 'Cancelar',
            save: 'Guardar',
            delete: 'Eliminar',
            clear: 'Limpiar',
            export: 'Exportar',
            saving: 'Guardando...',
            add: 'Añadir',
            page: 'Página',
            pagesCount: '{{count}} páginas',
        },
        language: {
            es: 'Español',
            en: 'Inglés',
            gl: 'Galego',
        },
        editor: {
            addFirst: 'Añadir primer archivo',
            dragDropTitle: 'Arrastra y suelta archivos aquí',
            dragDropDescription: 'O usa el botón superior para empezar.',
            zoomIn: 'Acercar',
            zoomOut: 'Alejar',
            undo: 'Deshacer',
            redo: 'Rehacer',
            pageSizeOriginal: 'Original',
            pageSizeA4: 'A4',
            pageSizeA3: 'A3',
            pageSizeLetter: 'Carta',
            pageSizeLegal: 'Legal',
            exportFailed: 'No se pudo exportar el PDF.',
            downloadPrefix: 'documento_editado',
            originalSizeName: 'original',
            rotate: 'Rotar',
            deletePage: 'Eliminar página',
            rotateSelected: 'Rotar selección',
            deleteSelected: 'Eliminar selección',
            duplicateSelected: 'Duplicar selección',
            exportAll: 'Exportar todo',
            exportSelected: 'Exportar selección',
            exportRange: 'Exportar rango',
            rangeStart: 'Inicio de rango',
            rangeEnd: 'Fin de rango',
            selectedCount: '{{count}} seleccionadas',
            protectPdf: 'Proteger PDF',
            unlockPdf: 'Desbloquear PDF',
            protectHint: 'Genera un PDF protegido con contraseña desde el documento actual.',
            unlockHint: 'Selecciona un PDF protegido e introduce su contraseña para quitar la protección.',
            password: 'Contraseña',
            confirmPassword: 'Confirmar contraseña',
            selectFile: 'Seleccionar archivo',
            noFileSelected: 'Ningún archivo seleccionado',
            invalidPassword: 'Contraseña inválida.',
            passwordMismatch: 'Las contraseñas no coinciden.',
            protectFailed: 'No se pudo proteger el PDF.',
            unlockFailed: 'No se pudo desbloquear el PDF.',
            unlockInvalidFile: 'Selecciona un archivo PDF válido.',
            protectedDownloadPrefix: 'documento_protegido',
            unlockedDownloadPrefix: 'documento_desbloqueado',
        },
        modal: {
            select: 'Seleccionar',
            text: 'Texto',
            draw: 'Dibujar',
            rect: 'Rectángulo',
            circle: 'Círculo',
            line: 'Línea',
            image: 'Imagen',
            deleteSelection: 'Eliminar selección',
            typeHere: 'Escribe aquí...',
            bold: 'Negrita',
            italic: 'Cursiva',
        },
        preview: {
            error: 'Error al cargar vista previa',
        },
    },
    en: {
        app: {
            title: 'PDFing',
            windowTitle: 'PDFing - PDF Editor',
        },
        common: {
            language: 'Language',
            cancel: 'Cancel',
            save: 'Save',
            delete: 'Delete',
            clear: 'Clear',
            export: 'Export',
            saving: 'Saving...',
            add: 'Add',
            page: 'Page',
            pagesCount: '{{count}} pages',
        },
        language: {
            es: 'Spanish',
            en: 'English',
            gl: 'Galician',
        },
        editor: {
            addFirst: 'Add first file',
            dragDropTitle: 'Drag & Drop files here',
            dragDropDescription: 'Or use the top button to start.',
            zoomIn: 'Zoom in',
            zoomOut: 'Zoom out',
            undo: 'Undo',
            redo: 'Redo',
            pageSizeOriginal: 'Original',
            pageSizeA4: 'A4',
            pageSizeA3: 'A3',
            pageSizeLetter: 'Letter',
            pageSizeLegal: 'Legal',
            exportFailed: 'Failed to export PDF.',
            downloadPrefix: 'edited_document',
            originalSizeName: 'original',
            rotate: 'Rotate',
            deletePage: 'Delete page',
            rotateSelected: 'Rotate selected',
            deleteSelected: 'Delete selected',
            duplicateSelected: 'Duplicate selected',
            exportAll: 'Export all',
            exportSelected: 'Export selected',
            exportRange: 'Export range',
            rangeStart: 'Range start',
            rangeEnd: 'Range end',
            selectedCount: '{{count}} selected',
            protectPdf: 'Protect PDF',
            unlockPdf: 'Unlock PDF',
            protectHint: 'Generate a password-protected PDF from the current document.',
            unlockHint: 'Choose a protected PDF and enter its password to remove protection.',
            password: 'Password',
            confirmPassword: 'Confirm password',
            selectFile: 'Select file',
            noFileSelected: 'No file selected',
            invalidPassword: 'Invalid password.',
            passwordMismatch: 'Passwords do not match.',
            protectFailed: 'Failed to protect PDF.',
            unlockFailed: 'Failed to unlock PDF.',
            unlockInvalidFile: 'Please select a valid PDF file.',
            protectedDownloadPrefix: 'protected_document',
            unlockedDownloadPrefix: 'unlocked_document',
        },
        modal: {
            select: 'Select',
            text: 'Text',
            draw: 'Draw',
            rect: 'Rectangle',
            circle: 'Circle',
            line: 'Line',
            image: 'Image',
            deleteSelection: 'Delete selection',
            typeHere: 'Type here...',
            bold: 'Bold',
            italic: 'Italic',
        },
        preview: {
            error: 'Error loading preview',
        },
    },
    gl: {
        app: {
            title: 'PDFing',
            windowTitle: 'PDFing - Editor de PDF',
        },
        common: {
            language: 'Idioma',
            cancel: 'Cancelar',
            save: 'Gardar',
            delete: 'Eliminar',
            clear: 'Limpar',
            export: 'Exportar',
            saving: 'Gardando...',
            add: 'Engadir',
            page: 'Páxina',
            pagesCount: '{{count}} páxinas',
        },
        language: {
            es: 'Castelán',
            en: 'Inglés',
            gl: 'Galego',
        },
        editor: {
            addFirst: 'Engadir primeiro ficheiro',
            dragDropTitle: 'Arrastra e solta ficheiros aquí',
            dragDropDescription: 'Ou usa o botón superior para comezar.',
            zoomIn: 'Achegar',
            zoomOut: 'Afastar',
            undo: 'Desfacer',
            redo: 'Refacer',
            pageSizeOriginal: 'Orixinal',
            pageSizeA4: 'A4',
            pageSizeA3: 'A3',
            pageSizeLetter: 'Carta',
            pageSizeLegal: 'Legal',
            exportFailed: 'Non foi posible exportar o PDF.',
            downloadPrefix: 'documento_editado',
            originalSizeName: 'orixinal',
            rotate: 'Xirar',
            deletePage: 'Eliminar páxina',
            rotateSelected: 'Xirar selección',
            deleteSelected: 'Eliminar selección',
            duplicateSelected: 'Duplicar selección',
            exportAll: 'Exportar todo',
            exportSelected: 'Exportar selección',
            exportRange: 'Exportar rango',
            rangeStart: 'Inicio do rango',
            rangeEnd: 'Fin do rango',
            selectedCount: '{{count}} seleccionadas',
            protectPdf: 'Protexer PDF',
            unlockPdf: 'Desbloquear PDF',
            protectHint: 'Xera un PDF protexido con contrasinal desde o documento actual.',
            unlockHint: 'Escolle un PDF protexido e introduce o seu contrasinal para quitar a protección.',
            password: 'Contrasinal',
            confirmPassword: 'Confirmar contrasinal',
            selectFile: 'Seleccionar ficheiro',
            noFileSelected: 'Ningún ficheiro seleccionado',
            invalidPassword: 'Contrasinal inválido.',
            passwordMismatch: 'Os contrasinais non coinciden.',
            protectFailed: 'Non foi posible protexer o PDF.',
            unlockFailed: 'Non foi posible desbloquear o PDF.',
            unlockInvalidFile: 'Selecciona un ficheiro PDF válido.',
            protectedDownloadPrefix: 'documento_protexido',
            unlockedDownloadPrefix: 'documento_desbloqueado',
        },
        modal: {
            select: 'Seleccionar',
            text: 'Texto',
            draw: 'Debuxar',
            rect: 'Rectángulo',
            circle: 'Círculo',
            line: 'Liña',
            image: 'Imaxe',
            deleteSelection: 'Eliminar selección',
            typeHere: 'Escribe aquí...',
            bold: 'Negra',
            italic: 'Cursiva',
        },
        preview: {
            error: 'Erro ao cargar a vista previa',
        },
    },
};

const isLocale = (value: string): value is Locale => value === 'es' || value === 'en' || value === 'gl';

const detectLocale = (): Locale => {
    if (typeof window === 'undefined') {
        return 'es';
    }

    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && isLocale(stored)) {
        return stored;
    }

    const browserLang = window.navigator.language.toLowerCase();
    if (browserLang.startsWith('gl')) {
        return 'gl';
    }
    if (browserLang.startsWith('en')) {
        return 'en';
    }
    return 'es';
};

const getByPath = (source: TranslationNode, path: string): string | undefined => {
    const keys = path.split('.');
    let current: TranslationNode | undefined = source;

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
    const [locale, setLocale] = useState<Locale>(detectLocale);

    useEffect(() => {
        if (typeof window !== 'undefined') {
            window.localStorage.setItem(STORAGE_KEY, locale);
        }
    }, [locale]);

    const t = useCallback((key: string, params?: Record<string, string | number>) => {
        const template = getByPath(translations[locale], key) ?? getByPath(translations.es, key) ?? key;
        return interpolate(template, params);
    }, [locale]);

    const value = useMemo(() => ({ locale, setLocale, t }), [locale, t]);

    return (
        <I18nContext.Provider value={value}>
            {children}
        </I18nContext.Provider>
    );
};

// eslint-disable-next-line react-refresh/only-export-components
export const useI18n = () => {
    const context = useContext(I18nContext);
    if (!context) {
        throw new Error('useI18n must be used within I18nProvider');
    }
    return context;
};

