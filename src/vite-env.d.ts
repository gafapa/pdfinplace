/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_APP_ENV?: 'development' | 'production';
    readonly VITE_CANONICAL_URL?: string;
    readonly VITE_ROBOTS?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
