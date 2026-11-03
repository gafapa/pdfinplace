import { createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { useSavedAssets, type SavedAssetsState } from '../components/page-editor/useSavedAssets';
import { clearPersistedAssets, loadPersistedAssets, savePersistedAssets } from '../utils/persistedAssets';

const waitFor = async (condition: () => boolean | Promise<boolean>) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if (await condition()) return;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Saved asset harness timed out.');
};

/** Browser-only regression harness; never imported by the application entry point. */
export const checkSavedAssets = async () => {
    localStorage.setItem('pageforge.local-persistence-enabled', 'true');
    localStorage.removeItem('pageforge.saved-assets');
    await clearPersistedAssets();
    const first = { id: 'first', name: 'First', dataUrl: 'data:image/png;base64,AQID', width: 10, height: 10 };
    await savePersistedAssets([first]);
    let state: SavedAssetsState | undefined;
    const errors: string[] = [];
    const Harness = () => {
        state = useSavedAssets({ persistenceFailed: 'failed', libraryTooLarge: 'large' }, message => errors.push(message));
        return null;
    };
    const mount = () => {
        state = undefined;
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        root.render(createElement(StrictMode, null, createElement(Harness)));
        return () => { root.unmount(); host.remove(); };
    };
    let unmount = mount();
    try {
        await waitFor(() => state?.isReady === true);
        if (state?.savedAssets[0]?.id !== first.id) throw new Error('Strict Mode did not restore the library.');
        state.addSavedAsset({ ...first, id: 'second' });
        await waitFor(async () => (await loadPersistedAssets()).length === 2);
        if (errors.length) throw new Error('Valid library reported a persistence failure.');
        unmount();
        await savePersistedAssets(Array.from({ length: 30 }, (_, index) => ({ ...first, id: `asset-${index}` })));
        unmount = mount();
        await waitFor(() => state?.isReady === true);
        if (state?.addSavedAsset({ ...first, id: 'overflow' }) !== false || state.savedAssets.length !== 30) throw new Error('A full library silently discarded an existing asset.');
        if (errors.pop() !== 'large') throw new Error('A full library did not report its limit.');
        unmount();
        localStorage.setItem('pageforge.saved-assets', '{damaged');
        unmount = mount();
        await waitFor(() => state?.isReady === true);
        if ((await loadPersistedAssets()).length !== 30 || !errors.length) throw new Error('Failed restore overwrote recoverable data.');
        if (state?.addSavedAsset(first) !== false) throw new Error('Failed restore accepted a misleading persistent save.');
        return { strictModeRestoreAndSave: true, failedRestorePreserved: true, libraryLimitPreserved: true };
    } finally {
        unmount();
        localStorage.removeItem('pageforge.saved-assets');
        localStorage.setItem('pageforge.local-persistence-enabled', 'false');
        await clearPersistedAssets();
    }
};
