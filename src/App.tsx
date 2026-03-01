import { useEffect } from 'react';
import { PdfEditor } from './pages/PdfEditor';
import { useI18n } from './i18n';

function App() {
  const { t, locale } = useI18n();

  useEffect(() => {
    document.title = t('app.windowTitle');
  }, [locale, t]);

  return (
    <div className="h-[100dvh] font-sans text-gray-900 bg-white">
      <main className="h-full overflow-hidden">
        <PdfEditor />
      </main>
    </div>
  );
}

export default App;
