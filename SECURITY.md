# Security And Local Data Boundaries

PDF in Place is a static application. Document processing runs in the browser;
there is no document-processing API, telemetry endpoint, or remote font dependency.
These controls reduce specific risks; they are not a guarantee that every malformed
document can be processed safely or that every PDF feature is supported.

## Untrusted Document Imports

- File count, source bytes, active pages, image dimensions, archive entries,
  expanded archive bytes, and XML element counts have explicit limits in
  `src/utils/importValidation.ts` and `src/hooks/editorResources.ts`.
- All DOCX XML/relationship parts are checked before the rendering library parses
  them. DTD and entity declarations are rejected. ODT content and style XML receive
  the same checks.
- DOCX/ODT layout runs in a temporary sandboxed iframe with scripts, forms, nested
  frames, and network access disabled by a document-specific CSP. Only embedded
  image data and font data may load. Document styles cannot affect the app shell.
- DOCX embedded HTML (`altChunk`) rendering is disabled. Markup is also stripped of
  interactive elements, event handlers, links, and remote image sources before
  capture. The iframe is removed on success or failure.
- Each capture obeys the pixel budget, including whole-document captures. Long
  documents use page windows when a complete bitmap would exceed it. Capture has
  a bounded timeout. WebKit's suppressed clone-frame load callback is completed
  by trusted parent code while document scripts remain disabled.
- Import failures release the tracked PDF loading task, including rejected batches.
  Cancellation does not commit partially staged imports.

Export removes automatic/additional actions, JavaScript, launches, form uploads,
chained actions, and XFA. Links allow HTTP, HTTPS, mail, telephone, and supported
local navigation; local form resets remain available. This does not make PDF
export a general-purpose forensic sanitizer.

## Local Storage And Recovery

Session persistence is opt-in. Saved sessions and reusable assets use IndexedDB;
preferences use localStorage. Session revisions are compared in the same transaction
as writes/clears so a stale tab cannot overwrite another tab's saved session.
Asset libraries are validated as a whole; a damaged restore reports an error and
does not replace the stored library with an empty array. Saved-asset restoration
also supports React Strict Mode's repeated effect setup/cleanup.
The 30-item limit rejects new entries instead of evicting existing signatures.
Persistent additions are blocked after a failed restore until recovery/reload.

Password-based unlocking validates credentials with PDF.js and checks the security
library's authenticated flag before removing encryption. Loading an encrypted
document object alone does not prove that a password was accepted. The dependency
contract test checks AES-256 output, wrong-password rejection and an unlocked
round trip using only a synthetic document.

The installed app's Web Share Target requires a temporary Cache Storage handoff,
even when long-term session persistence is off. Deliveries have separate random
identifiers and enforce the same 20-file, 75 MB/file and 250 MB/batch limits as
imports. Failed writes roll back only that delivery. Reading a file removes it
after its bytes are available in memory. A failed read leaves the URL parameter
available for retry. On a later delivery, timestamped entries older than one hour
are removed; this is opportunistic cleanup, not a background expiration guarantee.
Site-data controls remove all pending files. Legacy unbatched entries remain
readable with their original handoff URL.

The service worker caches app assets separately from the temporary document queue.
Offline-cache failures do not turn successful online requests into failures.
Production deployments must also apply the HTTP headers in `DEPLOYMENT.md`.
The local preview binds to loopback by default; exposing it to a network requires
an explicit host override.

## Dependency And Resource Integrity

Use the committed npm lockfile. Audit both development and runtime dependencies:

```bash
npm audit
npm run lint
npm test
npm run check:sw
npm run test:pdfjs-resources
npm run build
npm run test:browser:all
```

PDF.js worker and supporting resources come from the same installed package and
use fingerprinted URLs. The resource self-test checks WASM loading, intentional
drift detection, and repair of stale files; the build verifies the shipped assets.
Real browser rendering complements these binary/hash checks.

`npm run test:import-security` starts an owned localhost development server and
uses synthetic inputs to check sandbox isolation, blocked network requests,
disabled embedded HTML, auxiliary XML rejection, Strict Mode asset persistence,
and preservation after a failed restore. Unit regressions exercise share-delivery
rollback/limits and successful network responses when caching fails. These are
local automated checks, not production or independent security certification.
`npm run test:share-target` checks a real multipart navigation handled by the
production service worker, one import, and removal of the consumed handoff files.
`npm run test:legal` checks all eight locales of the three legal pages under a
strict `script-src 'self'` response policy. Their scripts are external same-origin
assets; the privacy page discloses temporary shared-file storage and does not
promise application-level encryption of the browser's asset library.

## Latest Local Verification (2026-11-03)

- 138 unit tests across 28 suites pass, including AES-256 password checks and
  readable unlocked output.
- TypeScript/production build, lint, service-worker syntax, PDF.js resource drift
  detection/repair, and built-resource verification pass.
- `npm audit` reports zero known advisories for the locked dependency tree.
- Chromium, Firefox and WebKit pass desktop/mobile editing, save/reopen/export,
  history/duplication, local recovery/conflicts, quota failures, cancellation,
  warm offline export, Office pagination, sandbox isolation, real share handoff,
  form filling, redaction and image compression checks.
- A browser regression commits a rapid pointer-down/up gesture in one task, before
  React can commit a drawing frame. Gestures use the synchronous start and actual
  release coordinates so the final position is not lost.
- All three legal pages render in all eight locales under strict script CSP in
  each of the three browser engines.

These results use generated fictitious documents and owned localhost servers on
Windows with Node.js 24. They qualify the local build and its tested workflows.
