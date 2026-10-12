import { useEffect, useRef } from 'react';

interface LaunchParams { files: readonly FileSystemFileHandle[] }
interface LaunchQueue { setConsumer: (consumer: (params: LaunchParams) => void) => void }

/** Cache where the service worker keeps files shared to the installed app (see public/sw.js). */
const SHARE_TARGET_CACHE = 'pageforge-share-target';
const SHARED_FILES_PARAM = 'shared-files';

const readSharedFiles = async () => {
    if (!('caches' in window)) return [];
    const cache = await caches.open(SHARE_TARGET_CACHE);
    const files: File[] = [];
    for (const request of await cache.keys()) {
        const response = await cache.match(request);
        await cache.delete(request);
        if (!response) continue;
        let name = 'shared-file';
        try {
            name = decodeURIComponent(response.headers.get('x-file-name') ?? name);
        } catch {
            // Keep the generic name for a malformed header.
        }
        files.push(new File([await response.blob()], name, { type: response.headers.get('content-type') ?? '' }));
    }
    return files;
};

/**
 * Hands over files opened with the installed PWA (File Handling API) or
 * shared to it (Web Share Target), waiting until the session is ready.
 */
export const useLaunchedFiles = (ready: boolean, onFiles: (files: File[]) => void) => {
    const pendingRef = useRef<File[]>([]);
    const readyRef = useRef(ready);
    const onFilesRef = useRef(onFiles);

    useEffect(() => {
        onFilesRef.current = onFiles;
    }, [onFiles]);

    useEffect(() => {
        readyRef.current = ready;
        if (ready && pendingRef.current.length > 0) {
            const files = pendingRef.current;
            pendingRef.current = [];
            onFilesRef.current(files);
        }
    }, [ready]);

    useEffect(() => {
        const enqueue = (files: File[]) => {
            if (files.length === 0) return;
            if (readyRef.current) onFilesRef.current(files);
            else pendingRef.current.push(...files);
        };

        const launchQueue = (window as Window & { launchQueue?: LaunchQueue }).launchQueue;
        launchQueue?.setConsumer((params) => {
            Promise.all(params.files.map(handle => handle.getFile())).then(enqueue).catch((error) => {
                console.error('Could not open the launched files:', error);
            });
        });

        const url = new URL(window.location.href);
        if (url.searchParams.has(SHARED_FILES_PARAM)) {
            url.searchParams.delete(SHARED_FILES_PARAM);
            window.history.replaceState(window.history.state, '', url);
            readSharedFiles().then(enqueue).catch((error) => {
                console.error('Could not read the shared files:', error);
            });
        }
    }, []);
};
