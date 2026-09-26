import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
// @ts-expect-error The synchronizer is intentionally executable Node.js ESM.
import { syncPdfJsResources } from './scripts/pdfjs-resources.mjs'

// Keep direct `vite` invocations aligned with the dependency, not only npm scripts.
syncPdfJsResources()

// https://vite.dev/config/
export default defineConfig({
  base: './',
  server: {
    allowedHosts: [
      'pdfing.gallego.top',
      'test.pdfing.gallego.top',
    ],
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: [
      'pdfing.gallego.top',
      'test.pdfing.gallego.top',
    ],
  },
  plugins: [
    react(),
    tailwindcss(),
  ],
  build: {
    // The heaviest PDF/security modules are lazy-only and intentionally excluded
    // from startup preloads, so we align the warning threshold with that reality.
    chunkSizeWarningLimit: 1400,
    modulePreload: {
      resolveDependencies: (_filename, deps) =>
        deps.filter((dep) => {
          return !(
            dep.includes('secure-pdf') ||
            dep.includes('pdf.worker') ||
            dep.includes('/pdf-') ||
            dep.includes('/doc-') ||
            dep.includes('/PdfEditor-') ||
            dep.includes('/PageEditorModal-') ||
            dep.includes('/dnd-')
          )
        }),
    },
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/@libpdf/core')) {
            return 'secure-pdf'
          }

          if (id.includes('node_modules/pdf-lib')) {
            return 'pdf-lib'
          }

          if (id.includes('node_modules/pdfjs-dist')) {
            return 'pdfjs'
          }

          if (
            id.includes('node_modules/docx-preview') ||
            id.includes('node_modules/jszip') ||
            id.includes('node_modules/html2canvas')
          ) {
            return 'doc'
          }

          if (
            id.includes('node_modules/@dnd-kit/core') ||
            id.includes('node_modules/@dnd-kit/sortable') ||
            id.includes('node_modules/@dnd-kit/utilities')
          ) {
            return 'dnd'
          }

          if (id.includes('node_modules/lucide-react')) {
            return 'icons'
          }
        },
      },
    },
  },
})
