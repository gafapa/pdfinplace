# PageForge

PageForge is a browser-based PDF editor built with React, TypeScript, Vite, Tailwind CSS, pdf.js, pdf-lib, and @libpdf/core.

It runs entirely in the browser. Imported documents, reusable signatures/stamps, preferences, and the current session are stored locally in the user's browser storage.

## Features

- Import PDF, JPG, PNG, DOCX, and ODT files.
- Reorder, rotate, duplicate, delete, select, split, and export pages.
- Export all pages, selected pages, or a page range.
- Add text, drawings, shapes, images, signatures, and stamps to pages.
- Add watermark, header, footer, margins, crop, and page numbers.
- Protect exported PDFs with AES-256 encryption.
- Unlock password-protected PDFs when the user provides the password.
- Restore the latest local editing session from IndexedDB.
- Install and run as a PWA.

## Local Development

```bash
npm install
npm run dev
```

## Quality Checks

```bash
npm run lint
npm run build
npm audit --omit=dev
```

The project includes a local `.npmrc` that points npm to the official npm registry, so `npm audit` works even when a global npm mirror is configured.

## Production Build

```bash
npm run build
npm run preview
```

The production app is emitted to `dist/`.

## Browser Storage And Privacy

PageForge does not upload files to a server. The browser stores:

- The current editing session in IndexedDB.
- Export history and UI preferences in localStorage.
- Saved signatures and stamps in localStorage.
- PWA shell and same-origin assets in the service worker cache.

Use the in-app clear action or the browser site-data controls to remove local data.

## Import Limits

The app rejects oversized imports before expensive parsing or rendering:

- Maximum files per batch: 20.
- Maximum single file size: 75 MB.
- Maximum batch size: 250 MB.
- Maximum active imported pages: 500.
- Maximum imported image size: 32 megapixels.
- Maximum rendered DOCX/ODT canvas height: 160,000 px.

These limits protect the browser from memory exhaustion when processing large PDFs or office documents.

## Dependency Notes

Most dependencies are kept on compatible semver ranges. Major upgrades such as Vite 8, ESLint 10, TypeScript 6, and Lucide 1 should be tested separately because they may require configuration or API changes.
