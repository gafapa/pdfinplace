type AppEnvironment = 'development' | 'production';

const configuredEnvironment = import.meta.env.VITE_APP_ENV;

export const APP_ENVIRONMENT: AppEnvironment =
    configuredEnvironment === 'development' ? 'development' : 'production';

export const isNonProductionEnvironment = APP_ENVIRONMENT !== 'production';
