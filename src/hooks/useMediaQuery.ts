import { useCallback, useSyncExternalStore } from 'react';

/** Whether a CSS media query currently matches, updated when it changes. */
export const useMediaQuery = (query: string) => {
    const subscribe = useCallback((onChange: () => void) => {
        if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
        const list = window.matchMedia(query);
        list.addEventListener('change', onChange);
        return () => list.removeEventListener('change', onChange);
    }, [query]);
    return useSyncExternalStore(
        subscribe,
        () => typeof window !== 'undefined' && Boolean(window.matchMedia?.(query).matches),
        () => false,
    );
};

/** The window's inner width, updated on resize. */
export const useViewportWidth = () => useSyncExternalStore(
    subscribeToResize,
    () => (typeof window === 'undefined' ? 1024 : window.innerWidth),
    () => 1024,
);

const subscribeToResize = (onChange: () => void) => {
    if (typeof window === 'undefined') return () => undefined;
    window.addEventListener('resize', onChange);
    return () => window.removeEventListener('resize', onChange);
};
