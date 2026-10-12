import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const reservePort = () => new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(error => error ? reject(error) : resolve(port));
    });
});

export const startLocalTestServer = async (mode = 'dev') => {
    const port = await reservePort();
    const url = `http://127.0.0.1:${port}`;
    let child;
    const stop = async () => {
        if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
        const current = child;
        await new Promise(resolve => {
            current.once('close', resolve);
            current.kill();
        });
    };
    const restart = async () => {
        const args = ['node_modules/vite/bin/vite.js', ...(mode === 'preview' ? ['preview'] : []), '--host', '127.0.0.1', '--port', String(port), '--strictPort'];
        child = spawn(process.execPath, args, { stdio: 'pipe', windowsHide: true });
        let output = '';
        let spawnError;
        child.on('error', error => { spawnError = error; });
        child.stdout.on('data', data => { output = (output + data).slice(-4000); });
        child.stderr.on('data', data => { output = (output + data).slice(-4000); });
        try {
            for (let attempt = 0; attempt < 240; attempt++) {
                if (spawnError) throw spawnError;
                if (child.exitCode !== null) throw new Error(`Local test server exited: ${output}`);
                // Terminals that force colour split the URL with ANSI escape codes.
                if (output.replace(/\u001b\[[0-9;]*m/g, '').includes(url)) {
                    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Wait for the owned local server. */ }
                }
                await delay(250);
            }
            throw new Error(`Local test server did not become ready: ${output}`);
        } catch (error) { await stop(); throw error; }
    };
    await restart();
    return { url, stop, restart };
};
