# Deployment

PDF in Place is deployed as a static single-page application.

## Environments

| Environment | URL | Build command | Search indexing |
| --- | --- | --- | --- |
| Production | `https://pdfinplace.com` | `npm ci && npm run build` | Enabled |

The build emits the complete static application to `dist/`. Deploy only the contents
of that directory. There is no public test environment. The server has an optional
`www.pdfinplace.com` redirect configured; public DNS for that alias is still absent
as of the [2026-11-03 publication](docs/releases/2026-11-03.md).

## Local Release Staging

The canonical server inventory, credential helpers, and upload procedure are
documented under `D:\gallego.top`. Before uploading, stage a complete build:

```powershell
npm run stage:production
```

This command builds production, rejects sensitive file types and links, checks
the destination, and mirrors `dist/` into the ignored project-local directory:

```text
.codex/deployment/static-sites/sites/pdfinplace.com/
```

Set `GALLEGOTOP_MANAGEMENT_ROOT` to use an existing management workspace instead.
After staging, follow
`D:\gallego.top\runbooks\static-site-content.md` for the content-only upload,
backup, remote verification, and rollback procedure. Credential access is
restricted to a temporary owner-only directory and plaintext key material is
removed after every operation.

Publish with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/publish-static-site.ps1 -Environment production -AllowProduction
```

This stages a fresh build, checks the domain against the current server inventory,
scans the exact public files, and uses the registered SSH host key. It uploads only
`pdfinplace.com`, verifies every uploaded file with SHA-256, creates and verifies
a rollback archive before replacing content, and invokes the server's installed
atomic content synchronization script. It verifies the live file hashes afterward.
The immediately previous release's hashed chunks and fingerprinted PDF.js files
remain available for open clients. A private server-side checksum manifest tracks
the current release, so older retained generations disappear on the next publish.
Explicit authorization to decrypt the deployment credential is required by the
server hub's `AGENTS.md`; `-AllowProduction` does not replace that authorization.
Publication is intentionally not exposed as an npm command.

## Static Server Requirements

`scripts/nginx/pdfinplace.com.conf` is the domain-specific configuration for the
current Nginx service (requires Nginx 1.29.3+ for
[`add_header_inherit merge`](https://nginx.org/en/docs/http/ngx_http_headers_module.html#add_header_inherit)). It applies response security headers,
keeps them on cache-specific locations, and uses the cache policies below. Back up
the live configuration, validate with `nginx -t`, and reload gracefully when changing
this file; content publication alone does not install server configuration.
The `static-pdfinplace` Traefik router uses the domain-specific
`pdfinplace-security` middleware in `scripts/traefik/pdfinplace-security.yml`.
It preserves HTTPS protections and prevents the shared proxy policy from replacing
the application's `no-referrer` policy. Merge only this middleware and this router's
middleware reference into the watched dynamic configuration; preserve other routes.

- Serve the domain only over HTTPS.
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

Every record must point to the selected static host or reverse proxy. Provision a valid certificate covering each name.

## Release Verification

After each deployment:

1. Open the site in a private browser window.
2. Confirm that the title has no environment prefix.
3. Confirm that PDF.js worker, font, CMap, ICC, and WASM requests return `200`.
4. Import a PDF, edit existing text, duplicate the page, and confirm that edits remain isolated.
5. Export the PDF and reopen it.
6. Verify the service worker and offline shell after one successful online load.
7. Confirm that `/robots.txt` and `/sitemap.xml` are served. Check the optional `www` alias separately: its permanent redirect also requires a public DNS record and a valid certificate.
8. Confirm that the HTTP response includes the CSP, COOP, CORP, permissions, referrer, HSTS, and MIME-sniffing headers listed above; the HTML meta policy is only a fallback.
