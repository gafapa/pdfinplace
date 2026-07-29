type AppEnvironment = 'development' | 'test' | 'production';

const configuredEnvironment = import.meta.env.VITE_APP_ENV;

export const APP_ENVIRONMENT: AppEnvironment =
    configuredEnvironment === 'development' || configuredEnvironment === 'test'
        ? configuredEnvironment
        : 'production';

export const isNonProductionEnvironment = APP_ENVIRONMENT !== 'production';
