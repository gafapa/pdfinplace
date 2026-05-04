import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [
    react(),
    tailwindcss(),
  ],
  build: {
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

          if (id.includes('node_modules/pdf-lib') || id.includes('node_modules/pdfjs-dist')) {
            return 'pdf'
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
