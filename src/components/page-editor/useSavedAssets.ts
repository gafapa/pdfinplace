import { useCallback, useEffect, useRef, useState } from 'react';
import { readBrowserPreference, removeBrowserPreference, writeBrowserPreference } from '../../utils/browserPreferences';
import { getSessionPersistencePreference } from '../../utils/sessionPreference';
import { clearPersistedAssets, loadPersistedAssets, savePersistedAssets, validatePersistedAssets, MAX_SAVED_ASSETS, MAX_SAVED_ASSET_BYTES, type PersistedAssetRecord } from '../../utils/persistedAssets';

export type SavedAsset = PersistedAssetRecord;

const SAVED_ASSETS_STORAGE_KEY = 'pageforge.saved-assets';
const ASSETS_PANEL_STORAGE_KEY = 'pageforge.assets-panel-open';

const getInitialAssetsPanelOpen = () => {
    if (typeof window === 'undefined') return false;
    return readBrowserPreference(ASSETS_PANEL_STORAGE_KEY) === 'true';
};

interface SavedAssetMessages {
    persistenceFailed: string;
    libraryTooLarge: string;
}

/**
 * The signature/stamp library: restored from IndexedDB (migrating the legacy
 * localStorage copy) when local sessions are enabled, and cleared otherwise.
 */
export const useSavedAssets = (messages: SavedAssetMessages, onError: (message: string) => void) => {
    const [savedAssets, setSavedAssets] = useState<SavedAsset[]>([]);
    const [isReady, setIsReady] = useState(false);
    const [isAssetsPanelOpen, setIsAssetsPanelOpen] = useState(getInitialAssetsPanelOpen);
    const [renamingAssetId, setRenamingAssetId] = useState<string | null>(null);
    const [assetNameDraft, setAssetNameDraft] = useState('');
    const persistenceReadyRef = useRef(false);
    const messagesRef = useRef(messages);
    const onErrorRef = useRef(onError);
    useEffect(() => {
        messagesRef.current = messages;
        onErrorRef.current = onError;
    });

    useEffect(() => {
        let cancelled = false;
        persistenceReadyRef.current = false;
        void (async () => {
            try {
                if (!getSessionPersistencePreference()) {
                    removeBrowserPreference(SAVED_ASSETS_STORAGE_KEY);
                    await clearPersistedAssets();
                    if (!cancelled) persistenceReadyRef.current = true;
                    return;
                }
                const legacyAssets = readBrowserPreference(SAVED_ASSETS_STORAGE_KEY);
                const parsedLegacyAssets = legacyAssets ? validatePersistedAssets(JSON.parse(legacyAssets)) : [];
                const persistedAssets = await loadPersistedAssets();
                const restoredAssets = persistedAssets.length > 0
                    ? persistedAssets
                    : Array.isArray(parsedLegacyAssets) ? parsedLegacyAssets : [];
                if (persistedAssets.length === 0 && restoredAssets.length > 0) {
                    await savePersistedAssets(restoredAssets);
                }
                removeBrowserPreference(SAVED_ASSETS_STORAGE_KEY);
                if (!cancelled) {
                    persistenceReadyRef.current = true;
                    setSavedAssets(restoredAssets);
                }
            } catch (error) {
                console.error('Failed to restore saved assets:', error);
                if (!cancelled) onErrorRef.current(messagesRef.current.persistenceFailed);
            } finally {
                if (!cancelled) setIsReady(true);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        // A failed restore must never overwrite recoverable disk data with [].
        if (!isReady || !persistenceReadyRef.current) return;
        void (async () => {
            try {
                if (getSessionPersistencePreference()) await savePersistedAssets(savedAssets);
                else await clearPersistedAssets();
            } catch (error) {
                console.error('Failed to persist saved assets:', error);
                onErrorRef.current(messagesRef.current.persistenceFailed);
            }
        })();
    }, [isReady, savedAssets]);

    useEffect(() => {
        writeBrowserPreference(ASSETS_PANEL_STORAGE_KEY, String(isAssetsPanelOpen));
    }, [isAssetsPanelOpen]);

    /** Adds an asset at the top of the library; false when the library would be too large. */
    const addSavedAsset = useCallback((asset: SavedAsset) => {
        if (!isReady || (getSessionPersistencePreference() && !persistenceReadyRef.current)) {
            onErrorRef.current(messagesRef.current.persistenceFailed);
            return false;
        }
        const nextAssets = [asset, ...savedAssets.filter(item => item.id !== asset.id)];
        const estimatedBytes = nextAssets.reduce((total, item) => total + Math.ceil(item.dataUrl.length * 0.75), 0);
        if (nextAssets.length > MAX_SAVED_ASSETS || estimatedBytes > MAX_SAVED_ASSET_BYTES) {
            onErrorRef.current(messagesRef.current.libraryTooLarge);
            return false;
        }
        setSavedAssets(nextAssets);
        return true;
    }, [savedAssets, isReady]);

    const removeSavedAsset = useCallback((assetId: string) => {
        setSavedAssets(previous => previous.filter(asset => asset.id !== assetId));
        setRenamingAssetId(previous => previous === assetId ? null : previous);
    }, []);

    const beginRenamingAsset = useCallback((asset: SavedAsset) => {
        setRenamingAssetId(asset.id);
        setAssetNameDraft(asset.name);
    }, []);

    const cancelRenamingAsset = useCallback(() => {
        setRenamingAssetId(null);
        setAssetNameDraft('');
    }, []);

    const commitAssetName = useCallback((assetId: string) => {
        const normalizedName = assetNameDraft.trim();
        if (!normalizedName) return;
        setSavedAssets(previous => previous.map(asset => asset.id === assetId ? { ...asset, name: normalizedName } : asset));
        setRenamingAssetId(null);
        setAssetNameDraft('');
    }, [assetNameDraft]);

    return {
        isReady,
        savedAssets,
        addSavedAsset,
        removeSavedAsset,
        isAssetsPanelOpen,
        setIsAssetsPanelOpen,
        renamingAssetId,
        assetNameDraft,
        setAssetNameDraft,
        beginRenamingAsset,
        cancelRenamingAsset,
        commitAssetName,
    };
};
export type SavedAssetsState = ReturnType<typeof useSavedAssets>;
