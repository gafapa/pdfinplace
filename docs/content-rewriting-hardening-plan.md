# Content rewriting hardening plan

## Objective and scope

Replace fragile visual-text matching with safe content rewriting for the reproduced
cases, keep preview and export consistent, and prevent incompatible PDF.js assets
from shipping. All document processing remains local. Implementation does not
authorize deployment or a GitHub push.

## Baseline evidence

The private two-page reproduction contains 51 nonempty PDF.js text items. Isolated
deletion succeeds for 43 and fails to locate 8. Replacing each item with `p` succeeds
for 32, fails to locate 8, and fails font encoding for 11. The original reproduction
does not contain the malformed transformation reported in the browser logs; that
error must not be attributed to this file without further reproduction.

The installed PDF.js worker and the checked-in QCMS WASM differ. The stale WASM
imports exactly the missing function in the reported LinkError. HTTP availability
alone does not establish runtime compatibility.

## Work streams

1. **Text and resources:** distinguish display normalization/grouping from source
   glyph operations; resolve transformed and nested occurrences; preserve text and
   line advances; clone shared resources before editing one occurrence. Add an
   explicit fallback for characters absent from a subset font without covering the
   old text. Reject ambiguous or unsupported cases without partial page changes.
2. **Images and syntax:** accept valid PDF number forms, validate operands and
   graphics-state nesting, preserve rotated/flipped transformations, and modify an
   occurrence rather than its shared image resource. Validate overlapping patches,
   excessive nesting, input sizes, and nonfinite geometry.
3. **Preview lifecycle:** coalesce rapid updates, invalidate stale work, avoid
   retries for unchanged failures, release temporary documents, and tie save
   eligibility to the current validated edit state. Preserve keyboard editing and
   recovery with localized, accessible feedback.
4. **Runtime integrity:** synchronize all PDF.js resource families from the installed
   package, validate their provenance/content during build, and prevent cached
   resources from a different version from satisfying new worker requests.
5. **Integration and audit:** verify original text removal, background and neighbor
   preservation, source immutability, shared form/image isolation, batch edits,
   preview/export parity, reopening, cancellation, and desktop/mobile behavior.

## Ownership

- Terra text agent: text engine, font handling, nested resources, synthetic tests.
- Terra assets agent: build/resource integrity and cache behavior.
- Terra preview/image agent: rendering lifecycle, image operations, UI recovery.
- Parent: integration, independent review, private-fixture browser validation, and
  documentation. Agents must coordinate shared APIs before touching another area.

## Acceptance gates

- Run the private fixture locally without adding it, extracted personal text, or
  screenshots of its contents to the repository. Report aggregate results only.
- Require explicit outcomes for all 51 text items and explain any remaining limit.
- Exercise real UI editing, restoration, saving, reopening, and final export.
- Add synthetic regressions for each fixed root cause so CI needs no private file.
- Pass tests, TypeScript/build, lint, and resource integrity checks.
- Verify WASM compatibility, not just file existence or an HTTP 200 response.
- Confirm no document upload requests and no repeated errors for unchanged state.

## Boundaries and further risks

This is not a universal PDF interpreter or a forensic redaction tool. Original
bytes may remain in unreferenced objects or metadata. Arbitrary CMaps, complex-script
shaping, tagged-PDF semantics, clipping text, inline images, annotations, and malformed
documents require explicit supported paths rather than silent visual covering.
Fallback fonts may change typography and must not imply exact font preservation.
Editing a digitally signed PDF cannot preserve the validity of its original
signature; verification codes printed on a document do not certify an edited copy.
Do not broaden this work into a certificate-verification or redaction feature.

## Handoff

Record implemented coverage, executed checks, remaining limitations, and publication
status. Publish only after a separate request, exclusively to pdfinplace.com.

## Verification outcome

- 61 automated tests pass across 12 suites, including export/reimport, shared Form
  isolation, failed-batch immutability, numeric syntax, dictionary rejection,
  normalized/whitespace-prefixed/grouped text, and explicit shared-worker ownership.
- The private fixture passes all 159 individual operations: delete/replace/move for
  51 text items and delete/move for three image items. Text counts and replacement/
  movement baselines are checked, and every resulting page is rendered.
- Batch deletion leaves zero nonempty extracted text items on both pages.
- Synthetic and private UI checks pass at 1440px and 390px: rapid updates,
  cancellation, unsupported-character recovery, save/reopen, real UI export,
  and another edit of that exported PDF. No uploads or WASM linkage errors occurred.
- Build, lint, resource drift checks, built-resource verification, service-worker
  syntax validation, and the scoped interface check pass.
- Two additional lifecycle bugs were reproduced and fixed during integration:
  temporary loads owning a shared PDFWorker, and destruction during a pending
  getPage request stranding the sequential preview queue.

The source PDF was not modified or added to the repository. No publication, commit,
or push was performed. Remaining PDF-format limitations are documented in
`content-rewriting.md`; this verification does not imply support for every PDF.
