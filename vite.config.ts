/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
// @ts-expect-error The synchronizer is intentionally executable Node.js ESM.
import { syncPdfJsResources } from './scripts/pdfjs-resources.mjs'

// Keep direct `vite` invocations aligned with the dependency, not only npm scripts.
syncPdfJsResources()

/** Emits robots.txt (and a sitemap when the build may be indexed) for the build's environment. */
const crawlerFiles = (): Plugin => {
  let canonicalUrl = ''
  let indexable = false
  return {
    name: 'pdfinplace-crawler-files',
    apply: 'build',
    configResolved(config) {
      canonicalUrl = config.env.VITE_CANONICAL_URL ?? ''
      indexable = (config.env.VITE_ROBOTS ?? '').startsWith('index')
    },
    generateBundle() {
      const lines = (...values: string[]) => `${values.join('\n')}\n`
      if (!indexable || !canonicalUrl) {
        this.emitFile({ type: 'asset', fileName: 'robots.txt', source: lines('User-agent: *', 'Disallow: /') })
        return
      }
      const sitemapUrl = new URL('sitemap.xml', canonicalUrl).href
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: lines('User-agent: *', 'Allow: /', '', `Sitemap: ${sitemapUrl}`) })
      const lastModified = new Date().toISOString().slice(0, 10)
      const pages = ['', 'privacidad.html', 'aviso-legal.html', 'terminos.html']
      this.emitFile({
        type: 'asset',
        fileName: 'sitemap.xml',
        source: lines(
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
          ...pages.map((page) => `  <url><loc>${new URL(page, canonicalUrl).href}</loc><lastmod>${lastModified}</lastmod></url>`),
          '</urlset>',
        ),
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: './',
  test: {
    // Bound native PDF/canvas workers to avoid memory and startup contention.
    maxWorkers: 2,
    // The first pdf.js import in a worker takes several seconds on cold caches.
    testTimeout: 20_000,
  },
  server: {
    allowedHosts: [
      'pdfinplace.com',
    ],
  },
  preview: {
    host: '127.0.0.1',
    allowedHosts: [
      'pdfinplace.com',
    ],
  },
  plugins: [
    react(),
    tailwindcss(),
    crawlerFiles(),
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
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // ZIP support is shared by image/split downloads and DOCX/ODT import.
            // The higher priority keeps it out of the document chunk, which would
            // otherwise pull it in as a dependency of docx-preview. jszip bundles
            // its own pako copy under node_modules/jszip.
            { name: 'zip', test: /node_modules[\\/](jszip|lie|immediate|setimmediate)[\\/]/, priority: 2 },
            { name: 'secure-pdf', test: /node_modules[\\/]@libpdf[\\/]core[\\/]/, priority: 1 },
            { name: 'pdf-lib', test: /node_modules[\\/]pdf-lib[\\/]/, priority: 1 },
            { name: 'pdfjs', test: /node_modules[\\/]pdfjs-dist[\\/]/, priority: 1 },
            { name: 'doc', test: /node_modules[\\/](docx-preview|html2canvas)[\\/]/, priority: 1 },
            { name: 'dnd', test: /node_modules[\\/]@dnd-kit[\\/](core|sortable|utilities)[\\/]/, priority: 1 },
            { name: 'icons', test: /node_modules[\\/]lucide-react[\\/]/, priority: 1 },
          ],
        },
      },
    },
  },
})
