import { Suspense, lazy, useEffect } from 'react';
import { useI18n } from './i18n';

const LazyPdfEditor = lazy(() =>
  import('./pages/PdfEditor').then((module) => ({ default: module.PdfEditor }))
);

function App() {
  const { t, locale } = useI18n();

  useEffect(() => {
    document.title = t('app.windowTitle');
  }, [locale, t]);

  return (
    <div className="h-[100dvh] font-sans text-gray-900 bg-white">
      <main className="h-full overflow-hidden">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center bg-white">
              <div className="h-8 w-8 rounded-full border-2 border-red-600 border-t-transparent animate-spin" />
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
