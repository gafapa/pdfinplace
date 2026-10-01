# PDF in Place

PDF in Place is a browser-based PDF editor built with React, TypeScript, Vite, Tailwind CSS, pdf.js, pdf-lib, fontkit, and @libpdf/core.

It runs entirely in the browser. Documents remain in memory unless the user enables local-session persistence. With persistence enabled, the current session and reusable signatures/stamps are stored locally in the user's browser storage.

## Features

- Import PDF, JPG, PNG, DOCX, and ODT files.
- Reorder, rotate, duplicate, delete, select, split, and export pages.
- Export all pages, selected pages, or a page range.
- Add text, drawings, shapes with optional solid fill, images, signatures, and stamps to pages.
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

Node.js `22.13+` or `24+` is required.

## Quality Checks

```bash
npm run lint
npm run check:sw
npm test
npm run test:pdfjs-resources
npm run build
npm run build:test
npm audit
```

The project includes a local `.npmrc` that points npm to the official npm registry, so `npm audit` works even when a global npm mirror is configured.
Run the browser check with Chromium and a local Vite server:

```bash
npx playwright install chromium
npm run dev
# In another terminal:
npm run test:browser
```

GitHub Actions runs these checks for pushes to `main`, pull requests, and manual runs from the Actions tab. CI installs Chromium and starts the local Vite server for the browser check.

CI uses one standard Ubuntu runner with Node.js 24, caches npm downloads, and does not upload artifacts. Each run has a 10-minute timeout, and a newer run on the same branch or pull request cancels the previous run to conserve the free allowance.

Standard GitHub-hosted runners are free for this public repository. If the repository becomes private, its runs count against the owner's monthly Actions allowance (2,000 minutes on GitHub Free). The workflow cannot enforce an account-wide spending limit; use an Actions budget with **Stop usage when budget limit is reached** enabled in the account's billing settings when one is needed. See [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) for current allowances and [budget controls](https://docs.github.com/en/billing/how-tos/set-up-budgets) for spending limits.

## Production Build

```bash
npm run build
```

The production app is emitted to `dist/` and is configured for `https://pdfinplace.com` and mirrored to `https://pdfing.gallego.top`.

Build the test environment with:

```bash
npm run build:test
```

The test build is configured for `https://test.pdfing.gallego.top`, displays a persistent `TEST` marker, and uses `noindex,nofollow`.

Stage complete builds in the canonical local server-management workspace with
`npm run stage:production` and `npm run stage:test`.

See [DEPLOYMENT.md](./DEPLOYMENT.md) for static hosting, caching, HTTPS, and security-header requirements.

## Browser Storage And Privacy

PDF in Place does not upload files to a server. The browser stores:

- The current editing session in IndexedDB when local-session persistence is enabled.
- Export history and UI preferences in localStorage.
- Saved signatures and stamps in IndexedDB when local-session persistence is enabled.
- PWA shell and same-origin assets in the service worker cache.

The in-app clear action removes the current session, export history, output options, and saved signatures/stamps. Browser site-data controls also remove non-sensitive UI preferences such as language and zoom.

## Import Limits

The app rejects oversized imports before expensive parsing or rendering:

- Maximum resident source files, including files retained for undo: 20.
- Maximum single file size: 75 MB.
- Maximum resident source data, including files retained for undo: 250 MB.
- Maximum active imported pages: 500.
- Maximum imported image size: 32 megapixels.
- Maximum rendered DOCX/ODT area: 32 megapixels.
- Maximum DOCX/ODT archive entries: 2,000.
- Maximum Office XML elements: 200,000.
- Maximum single uncompressed archive entry: 50 MB.
- Maximum total uncompressed archive size: 150 MB.

Office archives are inspected before their contents are rendered. Source files that are no longer referenced by the bounded undo history are released. These limits reduce the risk of browser memory exhaustion from oversized documents and compressed archive bombs.

## Existing Content Editing

The page editor analyzes existing text and raster images only when the **Edit content** tool is activated. Saved sessions contain only the modified content blocks, while the parsed page structure remains in memory.

Each edited output page is copied into an isolated in-memory PDF before its content changes are applied. This keeps edits independent when the same source page has been duplicated. The existing annotation layer is rendered after content changes.

PDF text editing is inherently approximate when the original embedded font cannot be reused. PDF in Place selects a compatible standard font and embeds a subset of Liberation Sans or Noto Sans CJK for supported Unicode replacement text. Characters absent from the bundled fonts produce an explicit error before saving. Image moves use a rendered snapshot, so vector image data is not preserved.

## Dependency Notes

Dependencies are kept on compatible semver ranges and audited in CI. TypeScript 7 is deferred until the TypeScript ESLint toolchain declares support for it.
