# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Anyone who needs to work with PDF documents in a web browser. The product is intended for a broad audience rather than a specialized professional role.

## Product Purpose

PDF in Place enables people to edit, organize, protect, unlock, split, and export PDF documents directly in their browser. Success means that a user can complete a practical PDF workflow without sending their files to a remote service.

## Positioning

Document processing happens locally in the browser. PDF in Place does not depend on a backend and does not upload the user's documents to a server.

## Operating Context

Users import PDF documents, images, DOCX files, or ODT files into a browser-based workspace. They can arrange pages, edit page content and annotations, configure output, protect or unlock PDFs, and download the resulting documents. Optional session persistence stores working data locally on the user's device.

## Capabilities and Constraints

- The product must preserve local processing and must not require a backend.
- User documents must remain on the user's device throughout the workflow.
- The current import surface accepts PDF, JPG, PNG, DOCX, and ODT files.
- PDF workflows include page reordering, rotation, duplication, deletion, selection, splitting, annotation, content editing, export configuration, password protection, and password removal.
- The interface currently supports Spanish, English, Galician, French, and German.
- The product is delivered as a responsive web application and progressive web app.

## Brand Commitments

The product name is **PDF in Place**. Product language should be direct, practical, and understandable to a general audience. Privacy claims must remain limited to the confirmed local-processing and no-backend architecture.

## Evidence on Hand

- Product implementation and workflows: `src/`
- Localized product copy: `src/i18n/index.tsx`
- Progressive web app manifest and service worker: `public/manifest.webmanifest` and `public/sw.js`
- Legal, privacy, and terms pages: `public/aviso-legal.html`, `public/privacidad.html`, and `public/terminos.html`
- Product and development documentation: `README.md` and `DEPLOYMENT.md`
- No testimonials, customer logos, usage benchmarks, pricing claims, or third-party validation are currently available and future work must not fabricate them.

## Product Principles

1. Keep every document private by processing it on the user's device.
2. Complete useful PDF workflows without requiring accounts, uploads, or backend services.
3. Make document operations understandable to people without specialist PDF knowledge.
4. Preserve the user's control over local session storage and exported files.
