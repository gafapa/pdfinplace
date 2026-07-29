import { Suspense, lazy, useEffect } from 'react';
import { useI18n } from './i18n';
import { APP_ENVIRONMENT, isNonProductionEnvironment } from './config/environment';

const LazyPdfEditor = lazy(() =>
  import('./pages/PdfEditor').then((module) => ({ default: module.PdfEditor }))
);

function App() {
  const { t, locale } = useI18n();

  useEffect(() => {
    const environmentPrefix = APP_ENVIRONMENT === 'test'
      ? '[TEST] '
      : APP_ENVIRONMENT === 'development'
        ? '[DEV] '
        : '';
    document.title = `${environmentPrefix}${t('app.windowTitle')}`;
    document.documentElement.lang = locale;
    document.documentElement.dataset.environment = APP_ENVIRONMENT;
  }, [locale, t]);

  return (
    <div className="h-[100dvh] font-sans text-gray-900 bg-white">
      {isNonProductionEnvironment ? (
        <div
          role="status"
          className="pointer-events-none fixed bottom-2 left-2 z-[100] rounded-md border border-amber-300 bg-amber-100/95 px-2 py-1 text-[10px] font-extrabold tracking-[0.16em] text-amber-950 shadow-sm"
        >
          {APP_ENVIRONMENT === 'test' ? 'TEST' : 'DEV'}
        </div>
      ) : null}
      <main className="h-full overflow-hidden">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center bg-white">
              <div className="h-8 w-8 rounded-full border-2 border-red-600 border-t-transparent animate-spin motion-reduce:animate-none" />
            </div>
          }
        >
          <LazyPdfEditor />
        </Suspense>
      </main>
    </div>
  );
}

export default App;
