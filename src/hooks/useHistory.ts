import { useState, useCallback } from 'react';
const MAX_HISTORY_ENTRIES = 80;

export const useHistory = <T>(initialState: T) => {
    const [historyState, setHistoryState] = useState<{ history: T[]; currentIndex: number }>({
        history: [initialState],
        currentIndex: 0
    });

    const state = historyState.history[historyState.currentIndex];

    const setState = useCallback((newState: T | ((prev: T) => T)) => {
        setHistoryState(prev => {
            const current = prev.history[prev.currentIndex];
            const updated = typeof newState === 'function'
                ? (newState as (prev: T) => T)(current)
                : newState;

            const truncatedHistory = prev.history.slice(0, prev.currentIndex + 1);
            const nextHistory = [...truncatedHistory, updated].slice(-MAX_HISTORY_ENTRIES);
            return {
                history: nextHistory,
                currentIndex: nextHistory.length - 1
            };
        });
    }, []);

    const undo = useCallback(() => {
        setHistoryState(prev => ({
            ...prev,
            currentIndex: Math.max(0, prev.currentIndex - 1)
        }));
    }, []);

    const redo = useCallback(() => {
        setHistoryState(prev => ({
            ...prev,
            currentIndex: Math.min(prev.history.length - 1, prev.currentIndex + 1)
        }));
    }, []);

    const setHistory = useCallback((nextHistory: T[]) => {
        setHistoryState(prev => ({ ...prev, history: nextHistory }));
    }, []);

    const setCurrentIndex = useCallback((nextIndex: number) => {
        setHistoryState(prev => ({ ...prev, currentIndex: nextIndex }));
    }, []);

    const canUndo = historyState.currentIndex > 0;
    const canRedo = historyState.currentIndex < historyState.history.length - 1;

    return {
        state,
        setState,
        undo,
        redo,
        canUndo,
        canRedo,
        history: historyState.history,
        setHistory,
        setCurrentIndex
    };
};

