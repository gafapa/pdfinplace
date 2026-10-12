import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditorSnapshot } from './editorTools';

const MAX_EDITOR_HISTORY = 100;
// Changes closer together than this (e.g. dragging a colour picker or typing) form one undo step.
const HISTORY_COALESCE_MS = 400;

interface EditorHistoryOptions {
    /** False while a gesture or text edit is in progress, so one gesture is one step. */
    canRecord: boolean;
    /** True once the snapshot holds the editor's starting state. */
    canSeed: boolean;
    /** False while undo/redo must not run (e.g. while editing text). */
    canRestore: () => boolean;
    onRestore: (snapshot: EditorSnapshot) => void;
}

/** Editor-local undo history of annotations, content edits and form values. */
export const useEditorHistory = (snapshot: EditorSnapshot, { canRecord, canSeed, canRestore, onRestore }: EditorHistoryOptions) => {
    const historyRef = useRef<{ entries: EditorSnapshot[]; index: number; lastChange: number }>({ entries: [], index: -1, lastChange: 0 });
    const [position, setPosition] = useState({ index: -1, length: 0 });
    const { annotations, contentEdits, formValues } = snapshot;

    useEffect(() => {
        if (!canRecord) return;
        const history = historyRef.current;
        const next = { annotations, contentEdits, formValues };
        if (history.entries.length === 0) {
            if (!canSeed) return;
            history.entries = [next];
            history.index = 0;
            setPosition({ index: 0, length: 1 });
            return;
        }
        const current = history.entries[history.index];
        if (current.annotations === annotations && current.contentEdits === contentEdits && current.formValues === formValues) return;
        const now = Date.now();
        const entries = history.entries.slice(0, history.index + 1);
        const coalesce = history.index > 0
            && history.index === history.entries.length - 1
            && now - history.lastChange < HISTORY_COALESCE_MS;
        if (coalesce) entries[entries.length - 1] = next;
        else entries.push(next);
        history.entries = entries.slice(-MAX_EDITOR_HISTORY);
        history.index = history.entries.length - 1;
        history.lastChange = now;
        setPosition({ index: history.index, length: history.entries.length });
    }, [annotations, contentEdits, formValues, canRecord, canSeed]);

    const restore = useCallback((delta: 1 | -1) => {
        const history = historyRef.current;
        const nextIndex = history.index + delta;
        if (!canRestore() || nextIndex < 0 || nextIndex >= history.entries.length) return;
        history.index = nextIndex;
        // The first change after undo/redo always starts a new step.
        history.lastChange = 0;
        onRestore(history.entries[nextIndex]);
        setPosition({ index: nextIndex, length: history.entries.length });
    }, [canRestore, onRestore]);

    return {
        canUndo: position.index > 0,
        canRedo: position.index < position.length - 1,
        restore,
    };
};
