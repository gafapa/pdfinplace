import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';
import { startLocalTestServer } from './local-test-server.mjs';

const engines = { chromium, firefox, webkit };
const browserKind = process.env.BROWSER_KIND ?? 'chromium';
assert(browserKind in engines, 'Unsupported browser engine.');
const server = await startLocalTestServer('preview');
let browser;
try {
    browser = await engines[browserKind].launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    const failures = [];
    page.on('pageerror', error => failures.push(error.message));
    await page.route('**/*', async route => {
        const request = route.request();
        assert.equal(new URL(request.url()).origin, server.url, 'Legal pages must use local assets.');
        if (!request.isNavigationRequest()) return route.continue();
        const response = await route.fetch();
        await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'" } });
    });
    for (const name of ['privacidad', 'aviso-legal', 'terminos']) {
        for (const locale of ['es', 'en', 'gl', 'fr', 'de', 'pt', 'ca', 'eu']) {
            await page.goto(`${server.url}/${name}.html?lang=${locale}`);
            await page.waitForFunction(language => document.documentElement.lang === language && document.querySelector('#doc')?.textContent.trim().length > 100, locale);
            assert.equal(await page.locator('script:not([src])').count(), 0);
            if (name === 'privacidad') {
                assert.equal(await page.locator('#doc tbody tr').count(), 5);
                assert((await page.locator('#doc').textContent()).includes('Cache Storage'));
            }
        }
    }
    assert.deepEqual(failures, []);
    console.log(JSON.stringify({ browserKind, legalPages: 3, locales: 8, strictScriptCsp: true, privacyStorageDisclosure: true }));
} finally {
    await browser?.close();
    await server.stop();
}
