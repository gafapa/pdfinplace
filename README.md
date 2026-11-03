# PDF in Place

PDF in Place is a browser-based PDF editor built with React, TypeScript, Vite, Tailwind CSS, pdf.js, pdf-lib, fontkit, and @libpdf/core.

It runs entirely in the browser. Documents remain in memory unless the user enables local-session persistence. With persistence enabled, the current session and reusable signatures/stamps are stored locally in the user's browser storage.

## Features

- Import PDF, JPG, PNG, DOCX, and ODT files. DOCX and ODT documents keep their own page size and page breaks and are added as images rendered at twice screen resolution, so their text is not selectable.
- Open files with the installed app from the operating system, or share them to it on mobile.
- Reorder, rotate, duplicate, delete, select, split, and export pages.
- Export all pages, selected pages, or a page range. At the original size without margins or crop, exports keep links, form fields, and other page annotations. With another page size, margins, or crop, links still work and form fields and annotations are flattened into the page. Pages from one source share its fonts and images, so files do not grow, and objects that only linked pages left out of the export used are dropped.
- Fill in PDF form fields (text, check boxes, radio buttons, and lists) in the page editor; thumbnails and exports show the values.
- Redact areas of a page: they are blacked out and the page is exported as an image, so nothing under the boxes remains in the file.
- Compress images on export (balanced at 150 ppi or maximum at 96 ppi); the success message reports the savings.
- Name downloads after the source file (for example `invoice_edited.pdf`); splitting into several files downloads one ZIP.
- Add text, highlights, drawings, lines, arrows, shapes with optional fill and fill opacity, images, signatures, and stamps to pages. Text in any script supported by the bundled fonts is exported as selectable vector text.
- Undo and redo in the page editor (including form values), duplicate an element (Ctrl+D), and nudge it with the arrow keys (Shift for larger steps).
- Edit, move, restore, or remove existing PDF text and raster image content on an individual page.
- Add watermark, header, footer, margins, crop, and page numbers.
- Protect exported PDFs with AES-256 encryption.
- Unlock password-protected PDFs when the user provides the password.
- Restore the latest local editing session, including output settings, from IndexedDB.
- See pending saves and storage errors, retry failed saves, and detect conflicting edits in other tabs.
- Follow import/export progress and cancel operations before their results are committed or downloaded.
- Render nearby page thumbnails on demand while keeping offscreen page controls available.
- Install and run as a PWA.

## Local Development

```bash
npm install
npm run dev
```

Use Node.js `^22.13.0` or `>=24.0.0`, as specified in `package.json`.

## Project Layout And Maintenance

- `src/`: application code and unit/regression tests.
- `public/`: PWA assets, legal pages, bundled fonts, and generated PDF.js resources.
- `scripts/`: resource synchronization, local browser checks, and release tooling.
- `docs/content-rewriting.md`: content-editing architecture, limitations, and verification.
- `PRODUCT.md` and `DESIGN.md`: current product requirements and design system.
- `DEPLOYMENT.md`: staging and publication procedures.

`npm run dev` and `npm run build` generate PDF.js assets under
`public/pdfjs/<version-and-fingerprint>/` from the installed `pdfjs-dist` package.
The application uses only that fingerprinted directory. Do not restore the obsolete
unversioned `cmaps`, `iccs`, `standard_fonts`, or `wasm` directories under
`public/pdfjs/`, or copy resources manually from another PDF.js version.
Keep the current resource directory and its licenses; older local fingerprints can
be removed when no local process is using them. Production asset retention follows
the separate rolling-deployment rules in `DEPLOYMENT.md`.

`dist/` is disposable build output; `node_modules/` contains installed dependencies.
Neither belongs in source control. Keep the lockfile for reproducible installs.
Historical screenshots, sample PDFs, and one-off visual reports are not required
to develop or build the app. Keep private fixtures outside the repository.
Local tool configuration and project-catalog metadata are separate from runtime
assets; preserve them when they still serve the development environment.

## Quality Checks

```bash
npm run lint
npm run check:sw
npm test
npm run test:pdfjs-resources
npm run test:office
npm run test:import-security
npm run test:share-target
npm run test:legal
npm run test:tools
npm run build
npm audit
```

The project includes a local `.npmrc` that points npm to the official npm registry, so `npm audit` works even when a global npm mirror is configured.
Run the existing editing check with Chromium and a local Vite server:

```bash
npx playwright install chromium
npm run dev
# In another terminal:
npm run test:browser
```

Run the complete browser suite against both the development server and the built PWA:

```bash
npx playwright install chromium firefox webkit
npm run build
npm run test:browser:all
```

The runner starts and closes isolated localhost servers on dynamically allocated ports. It
checks editing at desktop/mobile sizes (including highlights, arrows, editor undo/redo and
duplication), DOCX/ODT conversion, form filling, redaction and image compression,
Office sandbox isolation, saved-asset recovery, real service-worker file handoff,
atomic conflicts across tabs, storage quota
rollback and retry, session restoration, thumbnail deferral, import/export
cancellation, and warm offline restoration/export in Chromium, Firefox, and WebKit.
All fixtures are generated locally and contain fictitious text. Optional screenshots
are written locally when `WORKBENCH_SCREENSHOT_DIR` is set; CI does not upload them.
Set `BROWSER_KINDS=chromium` for a focused run. `npm run test:workbench` runs only the
workbench checks and starts its own production preview. The offline test stops that
server, reloads the app from its real service-worker cache, exports the restored
session, and restarts the server. `WORKBENCH_TEST_URL` can target an existing local
preview, using browser offline emulation instead; the owned-server path avoids
engine-specific emulation differences.

GitHub Actions runs these checks for pushes to `main`, pull requests, and manual runs from the Actions tab. CI installs all three browser engines and runs the complete suite.

CI uses one standard Ubuntu runner with Node.js 24, caches npm downloads, and does not upload artifacts. Each run has a 20-minute timeout, and a newer run on the same branch or pull request cancels the previous run to conserve the free allowance.

Standard GitHub-hosted runners are free for this public repository. If the repository becomes private, its runs count against the owner's monthly Actions allowance (2,000 minutes on GitHub Free). The workflow cannot enforce an account-wide spending limit; use an Actions budget with **Stop usage when budget limit is reached** enabled in the account's billing settings when one is needed. See [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) for current allowances and [budget controls](https://docs.github.com/en/billing/how-tos/set-up-budgets) for spending limits.

## Production Build

```bash
npm run build
```

The production app is emitted to `dist/` with `https://pdfinplace.com/` as its canonical URL, plus a generated `robots.txt` and `sitemap.xml`. Development builds emit a `robots.txt` that disallows crawling.

Stage complete builds in the canonical local server-management workspace with
`npm run stage:production`.

See [DEPLOYMENT.md](./DEPLOYMENT.md) for static hosting, caching, HTTPS, and security-header requirements.

## Browser Storage And Privacy

PDF in Place does not upload files to a server. The browser stores:

- The current editing session in IndexedDB when local-session persistence is enabled.
- Export history and UI preferences in localStorage.
- Saved signatures and stamps in IndexedDB when local-session persistence is enabled.
- PWA shell and same-origin assets in the service worker cache.
- Files handed to the installed PWA through Web Share Target in a temporary local
  Cache Storage queue. Each delivery is isolated, checked against the import size
  limits, and removed after it is read. Expired queued files are removed when a
  later delivery arrives; browser site-data controls can clear the queue directly.

The in-app clear action removes the current session, export history, output options, and saved signatures/stamps. Browser site-data controls also remove non-sensitive UI preferences such as language and zoom.

## Save Recovery And Concurrent Tabs

With local persistence enabled, changes are saved after a short debounce and the
status remains pending until the IndexedDB transaction completes. Hiding the page
requests an immediate save. Closing the page warns about pending/error/conflicted
changes or an active operation; an asynchronous save during page shutdown is only
best effort, so the warning is not treated as a persistence guarantee.

Session writes and ordinary clears compare a monotonic revision inside the same
IndexedDB transaction as their mutation. A stale tab cannot overwrite, delete, or
resurrect another tab's saved session. BroadcastChannel notifications and focus
checks expose conflicts promptly; atomic revision checks remain the authority.
On a conflict, export the in-memory work before reloading. Storage errors pause
automatic saves and offer retry. A failed restore remains on disk; retry reloads
the application instead of silently clearing the saved session.

Turning local persistence off is an explicit site-wide privacy action and clears
the saved session/assets. Preference changes propagate to other open tabs.
Output settings are stored with the session, while legacy localStorage output
settings remain readable for migration.

Optional UI preferences fall back to in-memory defaults when localStorage is denied
or full, so editing and exporting remain usable without preference storage.

## Operation Cancellation

Cancellation is cooperative between files, pages, and processing stages. The UI
waits for a library's current non-interruptible call before releasing the operation.
Cancelled imports release staged documents without adding partial batches.
Exports check cancellation before emitting a download. Completed downloads cannot
be recalled. Existing workspace pages remain available after cancellation.

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

Dependencies are audited in CI. TypeScript 7 checks types during the build, while Biome lints TypeScript and React code without depending on the TypeScript compiler API.
Node.js type definitions stay on the Node 24 line used by CI.

See [SECURITY.md](./SECURITY.md) for document-input boundaries, temporary storage,
and the security regression checks. Dependency updates must regenerate PDF.js
resources and pass the browser checks before publication.
