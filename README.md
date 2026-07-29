# PageForge

PageForge is a browser-based PDF editor built with React, TypeScript, Vite, Tailwind CSS, pdf.js, pdf-lib, fontkit, and @libpdf/core.

It runs entirely in the browser. Imported documents, reusable signatures/stamps, preferences, and the current session are stored locally in the user's browser storage.

## Features

- Import PDF, JPG, PNG, DOCX, and ODT files.
- Reorder, rotate, duplicate, delete, select, split, and export pages.
- Export all pages, selected pages, or a page range.
- Add text, drawings, shapes, images, signatures, and stamps to pages.
- Edit, move, restore, or remove existing PDF text and raster image content on an individual page.
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

Node.js `20.19+`, `22.12+`, or `24+` is required.

## Quality Checks

```bash
npm run lint
npm test
npm run build
npm audit --omit=dev
```

The project includes a local `.npmrc` that points npm to the official npm registry, so `npm audit` works even when a global npm mirror is configured.
The same checks run automatically in GitHub Actions for pushes to `main` and pull requests.

## Production Build

```bash
npm run build
```

The production app is emitted to `dist/` and is configured for `https://pdfing.gallego.top`.

Build the test environment with:

```bash
npm run build:test
```

The test build is configured for `https://test.pdfing.gallego.top`, displays a persistent `TEST` marker, and uses `noindex,nofollow`.

Stage complete builds in the canonical local server-management workspace with
`npm run stage:production` and `npm run stage:test`.

See [DEPLOYMENT.md](./DEPLOYMENT.md) for static hosting, caching, HTTPS, and security-header requirements.

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
- Maximum rendered DOCX/ODT area: 32 megapixels.
- Maximum DOCX/ODT archive entries: 2,000.
- Maximum Office XML elements: 200,000.
- Maximum single uncompressed archive entry: 50 MB.
- Maximum total uncompressed archive size: 150 MB.

Office archives are inspected before their contents are rendered. These limits reduce the risk of browser memory exhaustion from oversized documents and compressed archive bombs.

## Existing Content Editing

The page editor analyzes existing text and raster images only when the **Edit content** tool is activated. Saved sessions contain only the modified content blocks, while the parsed page structure remains in memory.

Each edited output page is copied into an isolated in-memory PDF before its content changes are applied. This keeps edits independent when the same source page has been duplicated. The existing annotation layer is rendered after content changes.

PDF text editing is inherently approximate when the original embedded font cannot be reused. PageForge selects a compatible standard font and uses the bundled Liberation Sans fallback for Unicode text. Image moves use a rendered snapshot, so vector image data is not preserved.

## Dependency Notes

Dependencies are kept on compatible semver ranges and audited in CI. TypeScript 7 is intentionally deferred until the TypeScript ESLint toolchain declares support for it.
