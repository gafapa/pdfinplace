import { useCallback, useEffect, useRef, useState } from 'react';
import { createOperationTask, type OperationKind, type OperationProgress, type OperationTask } from '../utils/editorOperation';

export const useEditorOperation = () => {
    const controllerRef = useRef<AbortController | null>(null);
    const [operation, setOperation] = useState<OperationProgress | null>(null);
    const beginOperation = useCallback((kind: OperationKind): OperationTask | null => {
        if (controllerRef.current) return null;
        const controller = new AbortController();
        controllerRef.current = controller;
        setOperation({ kind, completed: 0, total: 0, cancelling: false });
        return createOperationTask(controller, (completed, total) => {
            setOperation(previous => previous ? { ...previous, completed, total } : previous);
        });
    }, []);
    const finishOperation = useCallback(() => {
        controllerRef.current = null;
        setOperation(null);
    }, []);
    const cancelOperation = useCallback(() => {
        controllerRef.current?.abort();
        setOperation(previous => previous ? { ...previous, cancelling: true } : previous);
    }, []);
    useEffect(() => () => { controllerRef.current?.abort(); }, []);
    return { isProcessing: operation !== null, operation, beginOperation, finishOperation, cancelOperation };
};

export type EditorOperationController = ReturnType<typeof useEditorOperation>;
