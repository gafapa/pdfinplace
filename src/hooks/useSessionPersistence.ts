import { removeBrowserPreference } from '../utils/browserPreferences';
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { EditorFile, EditorPage, PageSize, PrintOverlayOptions } from './editorTypes';
import { cloneArrayBuffer, releasePdfDocument } from './editorResources';
import { loadPdfDocumentWithTask } from '../utils/pdfjs';
import { clearPersistedSession, loadSessionSnapshot, savePersistedSession, SessionConflictError, type PersistedFileRecord } from '../utils/persistedSession';
import { clearPersistedAssets } from '../utils/persistedAssets';
import { MAX_IMPORT_FILES, MAX_IMPORT_PAGES, MAX_IMPORT_TOTAL_SIZE_BYTES } from '../utils/importValidation';
import { getSessionPersistencePreference, setSessionPersistencePreference, subscribeToSessionPreference } from '../utils/sessionPreference';

export const DEFAULT_PRINT_OVERLAY_OPTIONS: PrintOverlayOptions = {
    watermarkText: '', includePageNumbers: false, headerText: '', footerText: '', cropPercent: 0, marginPercent: 0,
};
export type SessionSaveStatus = 'loading' | 'disabled' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict';

interface SessionInput {
    files: Record<string, EditorFile>;
    pages: EditorPage[];
    pageSize: PageSize;
    printOverlayOptions: PrintOverlayOptions;
}
interface PersistenceContext extends SessionInput {
    setFiles: Dispatch<SetStateAction<Record<string, EditorFile>>>;
    setPagesHistory: (history: EditorPage[][]) => void;
    setPagesCurrentIndex: (index: number) => void;
    setPageSize: Dispatch<SetStateAction<PageSize>>;
    setPrintOverlayOptions: Dispatch<SetStateAction<PrintOverlayOptions>>;
}

const clearLegacyData = () => {
    for (const key of ['pageforge.export-history', 'pageforge.saved-assets', 'pageforge.overlay-options']) {
        removeBrowserPreference(key);
    }
};

const sameInput = (input: SessionInput | null, current: SessionInput) => input?.files === current.files && input?.pages === current.pages && input?.pageSize === current.pageSize && input?.printOverlayOptions === current.printOverlayOptions;

export const useSessionPersistence = ({ files, pages, pageSize, printOverlayOptions, setFiles, setPagesHistory, setPagesCurrentIndex, setPageSize, setPrintOverlayOptions }: PersistenceContext) => {
    const [isSessionReady, setIsSessionReady] = useState(false);
    const [isSessionPersistenceEnabled, setEnabled] = useState(getSessionPersistencePreference);
    const [saveStatus, setSaveStatus] = useState<SessionSaveStatus>('loading');
    const [hasSavedSession, setHasSavedSession] = useState(false);
    const revisionRef = useRef(0);
    const generationRef = useRef(0);
    const faultRef = useRef<'error' | 'conflict' | null>(null);
    const cacheRef = useRef<Record<string, PersistedFileRecord>>({});
    const queueRef = useRef<Promise<void>>(Promise.resolve());
    const snapshot = useMemo(() => ({ files, pages, pageSize, printOverlayOptions }), [files, pages, pageSize, printOverlayOptions]);
    const latestRef = useRef(snapshot);
    latestRef.current = snapshot;
    const savedRef = useRef<SessionInput | null>(null);
    const mountedRef = useRef(false);
    const restoreFailedRef = useRef(false);
    const channelRef = useRef<BroadcastChannel | null>(null);

    const reportFailure = useCallback((error: unknown) => {
        const fault = error instanceof SessionConflictError ? 'conflict' : 'error';
        faultRef.current = fault;
        if (mountedRef.current) setSaveStatus(fault);
    }, []);

    // Keep the revision current even when an older write finishes after a newer
    // edit. Subsequent writes wait for it before comparing their revision.
    const enqueue = useCallback((work: () => Promise<void>) => {
        const next = queueRef.current.then(work);
        queueRef.current = next.catch(reportFailure);
        return next;
    }, [reportFailure]);

    useEffect(() => {
        mountedRef.current = true;
        let cancelled = false;
        const generation = generationRef.current;
        const restore = async () => {
            const restored: Record<string, EditorFile> = {};
            try {
                if (!getSessionPersistencePreference()) {
                    clearLegacyData();
                    const result = await clearPersistedSession();
                    revisionRef.current = result.revision;
                    await clearPersistedAssets();
                    if (!cancelled) savedRef.current = latestRef.current;
                    return;
                }
                const { session, revision } = await loadSessionSnapshot();
                if (cancelled || generation !== generationRef.current) return;
                revisionRef.current = revision;
                if (!session) { savedRef.current = latestRef.current; return; }
                const bytes = session.files.reduce((total, file) => total + file.buffer.byteLength, 0);
                if (session.files.length > MAX_IMPORT_FILES || session.pages.length > MAX_IMPORT_PAGES || bytes > MAX_IMPORT_TOTAL_SIZE_BYTES) {
                    throw new Error('The saved session exceeds the current safety limits.');
                }
                for (const record of session.files) {
                    if (cancelled || generation !== generationRef.current) return;
                    const file = new File([cloneArrayBuffer(record.buffer)], record.name, { type: record.type, lastModified: record.lastModified });
                    const loaded = await loadPdfDocumentWithTask({ data: cloneArrayBuffer(record.buffer) });
                    restored[record.id] = { id: record.id, file, ...loaded, pageCount: record.pageCount };
                }
                if (cancelled || generation !== generationRef.current) return;
                const restoredPages = session.pages.map(page => ({ ...page, contentEdits: page.contentEdits ?? [] }));
                if (restoredPages.some(page => !restored[page.fileId])) throw new Error('A saved page has no source document.');
                const restoredOptions = session.printOverlayOptions ?? latestRef.current.printOverlayOptions;
                cacheRef.current = Object.fromEntries(session.files.map(file => [file.id, file]));
                savedRef.current = { files: restored, pages: restoredPages, pageSize: session.pageSize, printOverlayOptions: restoredOptions };
                setFiles(restored);
                setPagesHistory([restoredPages]);
                setPagesCurrentIndex(0);
                setPageSize(session.pageSize);
                setPrintOverlayOptions(restoredOptions);
                setHasSavedSession(restoredPages.length > 0);
            } catch (error) {
                // Preserve a failed restore on disk for recovery; never replace it
                // with an empty session merely because decoding/storage failed.
                Object.values(restored).forEach(releasePdfDocument);
                if (!cancelled) { restoreFailedRef.current = true; reportFailure(error); }
            } finally {
                if (cancelled || generation !== generationRef.current) Object.values(restored).forEach(releasePdfDocument);
                if (!cancelled) {
                    setIsSessionReady(true);
                    if (!faultRef.current) setSaveStatus(getSessionPersistencePreference() ? 'saved' : 'disabled');
                }
            }
        };
        void restore();
        return () => { cancelled = true; mountedRef.current = false; };
    }, [reportFailure, setFiles, setPagesHistory, setPagesCurrentIndex, setPageSize, setPrintOverlayOptions]);

    useEffect(() => {
        if (!isSessionReady) return;
        const detectRevision = (revision: number) => {
            if (getSessionPersistencePreference() && revision > revisionRef.current) reportFailure(new SessionConflictError());
        };
        if (typeof BroadcastChannel !== 'undefined') {
            const channel = new BroadcastChannel('pdfinplace-session-revisions');
            channelRef.current = channel;
            channel.onmessage = event => { if (typeof event.data?.revision === 'number') detectRevision(event.data.revision); };
        }
        const checkOnFocus = () => {
            void queueRef.current.then(() => loadSessionSnapshot()).then(result => detectRevision(result.revision)).catch(reportFailure);
        };
        window.addEventListener('focus', checkOnFocus);
        return () => {
            window.removeEventListener('focus', checkOnFocus);
            channelRef.current?.close();
            channelRef.current = null;
        };
    }, [isSessionReady, reportFailure]);

    useEffect(() => subscribeToSessionPreference(enabled => {
        setEnabled(enabled);
        generationRef.current += 1;
        if (!enabled) {
            cacheRef.current = {};
            faultRef.current = null;
            setSaveStatus('disabled');
            setHasSavedSession(false);
            void enqueue(async () => {
                clearLegacyData();
                const result = await clearPersistedSession();
                revisionRef.current = result.revision;
                await clearPersistedAssets();
            }).catch(() => undefined);
        } else {
            // Enabling storage must not restore an older session over live edits.
            savedRef.current = null;
            setSaveStatus('pending');
        }
    }), [enqueue]);

    const flushSession = useCallback(() => {
        const current = latestRef.current;
        const generation = generationRef.current;
        return enqueue(async () => {
            if (!mountedRef.current || !isSessionReady || !getSessionPersistencePreference() || generation !== generationRef.current || faultRef.current || sameInput(savedRef.current, current)) return;
            if (latestRef.current !== current) return;
            setSaveStatus('saving');
            const nextCache: Record<string, PersistedFileRecord> = {};
            const ids = new Set(current.pages.map(page => page.fileId));
            const records = await Promise.all(Object.values(current.files).filter(file => ids.has(file.id)).map(async data => {
                const record = cacheRef.current[data.id] ?? {
                    id: data.id, name: data.file.name, type: data.file.type, lastModified: data.file.lastModified,
                    pageCount: data.pageCount, buffer: await data.file.arrayBuffer(),
                };
                nextCache[data.id] = record;
                return record;
            }));
            if (!mountedRef.current || generation !== generationRef.current || latestRef.current !== current || !getSessionPersistencePreference()) return;
            const result = current.pages.length > 0
                ? await savePersistedSession({ files: records, pages: current.pages, pageSize: current.pageSize, printOverlayOptions: current.printOverlayOptions, savedAt: Date.now() }, revisionRef.current)
                : await clearPersistedSession(revisionRef.current);
            revisionRef.current = result.revision;
            channelRef.current?.postMessage({ revision: result.revision });
            cacheRef.current = nextCache;
            if (generation !== generationRef.current || !mountedRef.current) return;
            savedRef.current = current;
            setHasSavedSession(current.pages.length > 0);
            setSaveStatus(latestRef.current === current ? 'saved' : 'pending');
        }).catch(() => undefined);
    }, [enqueue, isSessionReady]);

    useEffect(() => {
        if (!isSessionReady || !isSessionPersistenceEnabled || faultRef.current || sameInput(savedRef.current, snapshot)) return;
        const timer = window.setTimeout(() => { void flushSession(); }, 600);
        return () => window.clearTimeout(timer);
    }, [snapshot, isSessionReady, isSessionPersistenceEnabled, flushSession]);

    useEffect(() => {
        const flushWhenHidden = () => { if (document.visibilityState === 'hidden') void flushSession(); };
        const flushOnPageHide = () => { void flushSession(); };
        document.addEventListener('visibilitychange', flushWhenHidden);
        window.addEventListener('pagehide', flushOnPageHide);
        return () => {
            document.removeEventListener('visibilitychange', flushWhenHidden);
            window.removeEventListener('pagehide', flushOnPageHide);
        };
    }, [flushSession]);

    const retrySessionSave = useCallback(() => {
        if (faultRef.current === 'conflict') return;
        if (restoreFailedRef.current) { window.location.reload(); return; }
        faultRef.current = null;
        setSaveStatus('pending');
        void flushSession();
    }, [flushSession]);

    const clearSession = useCallback(async () => {
        if (faultRef.current === 'conflict') return false;
        generationRef.current += 1;
        try {
            await enqueue(async () => {
                const result = await clearPersistedSession(getSessionPersistencePreference() ? revisionRef.current : undefined);
                revisionRef.current = result.revision;
                channelRef.current?.postMessage({ revision: result.revision });
                clearLegacyData();
                await clearPersistedAssets();
                cacheRef.current = {};
                savedRef.current = null;
                faultRef.current = null;
                restoreFailedRef.current = false;
                setHasSavedSession(false);
            });
            return true;
        } catch { return false; }
    }, [enqueue]);

    const sessionSaveStatus: SessionSaveStatus = !isSessionReady ? 'loading'
        : faultRef.current ? faultRef.current
        : !isSessionPersistenceEnabled ? 'disabled'
        : saveStatus === 'saving' ? 'saving'
        : sameInput(savedRef.current, snapshot) ? 'saved' : 'pending';
    const hasUnsavedChanges = (pages.length > 0 || (isSessionPersistenceEnabled && (savedRef.current?.pages.length ?? 0) > 0)) && sessionSaveStatus !== 'saved';
    return { isSessionReady, isSessionPersistenceEnabled, hasSavedSession, sessionSaveStatus, hasUnsavedChanges, retrySessionSave, flushSession, clearSession, setSessionPersistenceEnabled: setSessionPersistencePreference };
};
