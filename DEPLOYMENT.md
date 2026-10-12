# Deployment

PDF in Place is deployed as a static single-page application.

## Environments

| Environment | URL | Build command | Search indexing |
| --- | --- | --- | --- |
| Production | `https://pdfinplace.com` | `npm ci && npm run build` | Enabled |
| Test | `https://test.pdfinplace.com` | `npm ci && npm run build:test` | Disabled |

Both commands emit the complete static application to `dist/`. Deploy only the contents of that directory.

The test build displays a `TEST` marker and prefixes the browser title with `[TEST]`. Browser storage, IndexedDB, caches, and service workers are isolated naturally because the environments use different origins.

## Local Release Staging

The canonical server-management workspace and upload procedure are documented
under `D:\gallego.top`. Before uploading, stage a complete build in the local
content directory:

```powershell
npm run stage:production
npm run stage:test
```

These commands build the selected environment, reject sensitive file types,
verify that the destination is one of the registered PDF in Place site
directories, and mirror `dist/` into:

```text
D:\Otros IA\gestion_gallego_top\static-sites\sites\pdfinplace.com
D:\Otros IA\gestion_gallego_top\static-sites\sites\test.pdfinplace.com
```

Set `GALLEGOTOP_MANAGEMENT_ROOT` to override the management workspace location.
After staging, follow
`D:\gallego.top\runbooks\static-site-content.md` for the content-only upload,
backup, remote verification, and rollback procedure. Credential access is
restricted to a temporary owner-only directory and plaintext key material is
removed after every operation.

Publish the test environment with:

```powershell
npm run publish:test
```

This command stages a fresh test build, uploads only
`test.pdfinplace.com`, and invokes the server's atomic content
synchronization script. Production publication is intentionally not exposed as
an npm command. It requires an explicit invocation with
`-Environment production -AllowProduction`.

## Static Server Requirements

- Serve both domains only over HTTPS.
- Redirect HTTP to HTTPS.
- Serve `dist/index.html` for navigation requests that do not match a real file.
- Preserve exact paths for files under `assets/` and `pdfjs/`.
- Serve `.wasm` files as `application/wasm`.
- Serve `.webmanifest` as `application/manifest+json`.
- Do not proxy uploaded documents: all document processing happens in the browser.

## Recommended Security Headers

Configure these as HTTP response headers at the CDN or web server:

```text
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Referrer-Policy: no-referrer
Strict-Transport-Security: max-age=31536000
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
```

Also return this header from the test environment:

```text
X-Robots-Tag: noindex, nofollow
```

The HTML includes a matching CSP for static hosts that cannot configure response headers. The HTTP header remains authoritative and is preferred.

## Cache Policy

Recommended response caching:

| Path | Cache-Control |
| --- | --- |
| `/index.html`, `/sw.js`, `/manifest.webmanifest` | `no-cache` |
| `/assets/*` | `public, max-age=31536000, immutable` |
| `/pdfjs/*` | `public, max-age=86400` |
| Icons | `public, max-age=86400` |

Deploy the HTML and service worker after all other files. Keep the previous hashed assets available during a rolling deployment so open clients can finish loading their current version.

## DNS And TLS

Create DNS records for:

- `pdfinplace.com` (production)
- `www.pdfinplace.com` (redirect to `https://pdfinplace.com/`)
- `test.pdfinplace.com` (test)

Every record must point to the selected static host or reverse proxy. Provision a valid certificate covering each name.

## Release Verification

After each deployment:

1. Open the environment in a private browser window.
2. Confirm that the production title has no prefix and the test title starts with `[TEST]`.
3. Confirm that PDF.js worker, font, CMap, ICC, and WASM requests return `200`.
4. Import a PDF, edit existing text, duplicate the page, and confirm that edits remain isolated.
5. Export the PDF and reopen it.
6. Verify the service worker and offline shell after one successful online load.
7. Check the response headers and confirm that the test domain returns `X-Robots-Tag: noindex, nofollow`. Production must serve `/robots.txt` and `/sitemap.xml`; test must serve a `robots.txt` that disallows crawling.
8. Confirm that the HTTP response includes the CSP, COOP, CORP, permissions, referrer, HSTS, and MIME-sniffing headers listed above; the HTML meta policy is only a fallback.
