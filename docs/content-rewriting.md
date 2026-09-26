# PDF Content Stream Rewriting

PDF in Place applies existing-content edits by rewriting the affected page content
stream. The exporter removes or replaces the original drawing operation instead of
painting a background-coloured rectangle over it.

## Safe subset

The implementation supports an explicitly validated subset of page instructions:

- Direct page content streams, including pages whose `/Contents` entry is an array.
- Uniquely identifiable text-show instructions (`Tj`, `TJ`, `'`, or `"`), plus
  supported adjacent runs grouped by PDF.js, including intervening `Tr`/`w` style
  changes. Matching accounts for normalized text and initial whitespace advances.
- Literal and hexadecimal PDF strings that can be decoded and re-encoded without
  changing their character encoding.
- Text positioned through `Tm`, `Td`, `TD`, `T*`, or quote operators, including a
  resolvable non-identity graphics transform.
- Standard fonts and supported simple WinAnsi encodings, plus Type0 Identity-H
  fonts with an unambiguous supported ToUnicode mapping and available glyph widths.
  Supported WinAnsi replacement text can use a scoped Standard 14 Helvetica fallback
  when the original subset lacks its characters. Other supported Unicode text uses
  a subsetted Type0/CID fallback font with glyph widths and a ToUnicode map. The
  bundled fonts cover Cyrillic and common CJK text, including mixed runs that fit
  one font. The editor displays a notice because the alternative font may change
  typography. Characters absent from the bundled fonts fail explicitly.
- Nested Form XObjects with composed transforms and inherited resources. Editing
  one occurrence clones its resource path instead of changing a shared definition.

For a replacement at the original position, the rewritten instruction preserves the
following text advance, including numeric spacing in `TJ` arrays. For a moved
replacement, the exporter rewrites the related text matrix and restores the original
line state so following `Td`, `T*`, and quote operators retain their positions. A
deletion removes the matched show operation while keeping surrounding graphics
instructions intact.

Replacing a grouped item uses the first run's text style for the replacement and
retains the final style state for subsequent content. Moving an unchanged group
retains its original show instructions, kerning, and intervening style changes.

## Images

An image edit targets one `Do` occurrence, not the image resource. This matters when
one XObject is drawn more than once: deleting or moving one occurrence must leave all
other occurrences unchanged. The exporter only rewrites image occurrences with an
unambiguous graphics-state and transformation scope. Moving or resizing transformed
bounds preserves the original image rotation and reflection.

## Conservative failures

`ContentRewriteError` means the page cannot be rewritten safely. Common reasons are
ambiguous matching text, unsupported string encodings, indirect or nested content
that cannot be associated with a single page operation, and transformations that do
not have a unique scope.

The operation is transactional. When any requested edit is unsupported, the exporter
does not mutate the PDF page. Export stops with the page number and reason; it does
not download a PDF containing the unedited page.

## Preview and export flow

The editor keeps the imported source PDF immutable in a `WeakMap`. Each preview and
export starts from an isolated copy of the affected page, then calls the same content
stream rewriter. This gives the preview the same result as the exported PDF without
changing the source document.

Preview rendering happens on an offscreen canvas. The visible canvas keeps its last
complete frame until the new rewrite and render are ready. A newer edit invalidates
older work, so a stale render is never shown after a later change.

Loading tasks receive an explicitly shared PDFWorker so closing a temporary preview
cannot destroy another document's worker controller. Cancellation marks an old
generation stale and cancels active painting; its task is destroyed in the render's
finally block, never while `getPage()` is still pending. Only content-rewrite failures
are cached as rejected edits; a failed annotation image must not poison that cache.

When rewriting is unsupported, the editor blocks saving and page navigation that
would commit the edit. The user can still restore the selected content block to its
source state.

## Implementation status

1. Implemented: rewrite direct page text and image operations with an unambiguous source
   occurrence, preserving local graphics state, following text advances, and
   untouched page content.
2. Implemented: Form XObject occurrence rewriting with clone-on-write resources, so editing
   one use of a shared form does not change every use.
3. Future: support arbitrary CMaps, embedded font encodings, additional scripts, and complex text
   positioning with explicit source-to-glyph mapping.
4. Future: preserve and update marked-content and accessibility semantics when edited text is
   part of a tagged PDF.

## Guarantees and limits

Rewriting preserves the active page background and untouched operations. It removes
the matched drawing operation from the page's active `/Contents` streams instead of
placing a visual cover over it.

This is not a forensic PDF sanitiser. Unreferenced objects, document metadata,
incremental-save history, and other resources can still contain prior information.
Use a dedicated redaction workflow when permanent removal from every part of a PDF is
required.

Arbitrary CMaps, inline images, marked-content dictionaries, and text used as a
clipping path are not supported. Nesting, stream sizes, and operation counts have
bounded limits. Unrelated graphics
instructions remain unchanged; this is not a general validator for every PDF
construct. The browser keeps all processing local; no document content is uploaded
for this operation.

## Runtime integrity and verification

`npm run build` synchronizes PDF.js resources from the installed package, checks
their hashes and worker glue, and verifies the resources actually copied to `dist`.
The resource URL includes a fingerprint of both the worker and resource families.
`npm run test:pdfjs-resources` deliberately corrupts a temporary copy and verifies
that drift is detected. WASM link tests using stub imports are not a substitute for
rendering with the real worker; the browser integration check performs that render.

Optional local browser checks require a running Vite server, Playwright Core, and
Chrome. Set `PLAYWRIGHT_MODULE_PATH` and `CHROME_EXECUTABLE_PATH` when they are not
available through the default installation, then run:

```text
node scripts/verify-content-rewriting.mjs <local-private-fixture.pdf>
node scripts/verify-editor-ui.mjs <local-private-fixture.pdf>
node scripts/verify-editor-ui.mjs
```

The first command checks every parsed element, character counts, text baselines,
renderability, and batch deletion. The UI check exercises rapid typing, cancellation,
unsupported-input recovery, saving/reopening, actual export, and another edit of
that exported file, at desktop and mobile sizes. They refuse non-localhost servers,
block upload/external requests, and report aggregates without document text.
Only the synthetic UI fixture permits screenshots through `CONTENT_SCREENSHOT_DIR`.
