import { spawn } from 'node:child_process';
import { startLocalTestServer } from './local-test-server.mjs';

const servers = [];
const run = (args, env = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Browser check exited with ${code}.`)));
});
try {
    const server = await startLocalTestServer();
    servers.push(server);
    const browserKinds = (process.env.BROWSER_KINDS ?? 'chromium,firefox,webkit').split(',');
    for (const browserKind of browserKinds) {
        if (!['chromium', 'firefox', 'webkit'].includes(browserKind)) throw new Error('Unsupported browser engine.');
        console.log(`Checking ${browserKind}`);
        await run(['scripts/verify-editor-ui.mjs'], { BROWSER_KIND: browserKind, CONTENT_TEST_URL: server.url });
        await run(['scripts/verify-workbench.mjs'], { BROWSER_KIND: browserKind });
        await run(['scripts/verify-office-import.mjs'], { BROWSER_KIND: browserKind });
        await run(['scripts/verify-import-security.mjs'], { BROWSER_KIND: browserKind });
        await run(['scripts/verify-share-target.mjs'], { BROWSER_KIND: browserKind });
        await run(['scripts/verify-pdf-tools.mjs'], { BROWSER_KIND: browserKind });
    }
} finally {
    for (const server of servers) await server.stop();
}
