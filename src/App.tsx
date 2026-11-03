import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { useI18n } from './i18n';
import { APP_ENVIRONMENT, isNonProductionEnvironment } from './config/environment';
import { AppInfoDialog } from './components/AppInfoDialog';

const LazyPdfEditor = lazy(() =>
  import('./pages/PdfEditor').then((module) => ({ default: module.PdfEditor }))
);

function App() {
  const { t, locale } = useI18n();
  const [showInfo, setShowInfo] = useState(false);

  useEffect(() => {
    const environmentPrefix = isNonProductionEnvironment ? '[DEV] ' : '';
    document.title = `${environmentPrefix}${t('app.windowTitle')}`;
    document.documentElement.lang = locale;
    document.documentElement.dataset.environment = APP_ENVIRONMENT;
  }, [locale, t]);

  const closeInfo = useCallback(() => setShowInfo(false), []);
  const openInfo = useCallback(() => setShowInfo(true), []);

  return (
    <div className="h-[100dvh] bg-gray-100 font-sans text-gray-900">
      {isNonProductionEnvironment ? (
        <div
          role="status"
          className="pointer-events-none fixed bottom-2 left-2 z-[100] rounded-md border border-amber-300 bg-amber-100/95 px-2 py-1 text-[10px] font-extrabold tracking-[0.16em] text-amber-950 shadow-sm"
        >
          DEV
        </div>
      ) : null}
      <main className="h-full overflow-hidden">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center bg-gray-100">
              <div className="h-8 w-8 rounded-full border-2 border-red-600 border-t-transparent animate-spin motion-reduce:animate-none" />
            </div>
          }
        >
          <LazyPdfEditor onOpenInfo={openInfo} />
        </Suspense>
      </main>
      {showInfo ? <AppInfoDialog onClose={closeInfo} /> : null}
    </div>
  );
}

export default App;
