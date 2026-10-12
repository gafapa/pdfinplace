import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { I18nProvider } from './i18n'
import { detectLocale, loadLocale } from './i18n/loader'

if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener('load', () => {
      const baseUrl = import.meta.env.BASE_URL
      const serviceWorkerUrl = `${baseUrl}sw.js`
      navigator.serviceWorker.register(serviceWorkerUrl, { scope: baseUrl }).catch((error) => {
        console.error('Service worker registration failed:', error)
      })
    })
  } else {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      registrations.forEach((registration) => registration.unregister())
    }).catch((error) => {
      console.error('Service worker unregistration failed:', error)
    })
  }
}

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Root element #root was not found.')
}

// Load the visitor's language before the first render so the UI does not switch languages.
await loadLocale(detectLocale()).catch((error) => {
  console.error('Could not preload translations:', error)
})

createRoot(rootElement).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
)
